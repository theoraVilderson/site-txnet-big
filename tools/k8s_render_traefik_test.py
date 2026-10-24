#!/usr/bin/env python3
"""Spec for Traefik on Kubernetes (OPS-1-o-b, hosting contract.kubernetes.md K9).

Router and middleware labels become IngressRoute and Middleware objects; the
Traefik pod reads them through the CRD provider, behind a LoadBalancer that
keeps the client's address.

    python3 tools/k8s_render_traefik_test.py
"""
import base64
import copy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
from k8srender import RenderError, render  # noqa: E402
from k8srender.tables import BAKED_BINDS, TRAEFIK  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
OPTIONS = {"registry": "registry.example", "tag": "t1", "host_gateway": "10.0.0.5"}


def model(repo: Path) -> dict:
    """Traefik, the ForwardAuth gate and two backends — in the shape compose prints,
    where every literal `$` is doubled."""
    return {"services": {
        TRAEFIK: {
            "build": {"context": str(repo / "dev-docker/traefik")},
            "command": ["--api.dashboard=true", "--providers.docker=true",
                        "--providers.docker.exposedbydefault=false", "--entrypoints.web.address=:80",
                        "--providers.file.directory=/etc/traefik/dynamic"],
            "ports": [{"target": 80, "published": "80"}, {"target": 443, "published": "443"}],
            "extra_hosts": ["host.docker.internal=host-gateway"],
            "volumes": [
                {"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"},
                {"type": "bind", "source": str(repo / "dev_letsencrypt"), "target": "/letsencrypt"},
                *({"type": "bind", "source": str(repo / d), "target": f"/baked/{i}", "read_only": True}
                  for i, d in enumerate(sorted(BAKED_BINDS))),
            ],
            "labels": {
                "traefik.enable": "true",
                "traefik.http.routers.dashboard-https.rule": "Host(`monitor.example`)",
                "traefik.http.routers.dashboard-https.entrypoints": "websecure",
                "traefik.http.routers.dashboard-https.service": "api@internal",
                "traefik.http.routers.dashboard-https.middlewares": "auth-dashboard",
                "traefik.http.routers.dashboard-https.priority": "1000",
                "traefik.http.routers.dashboard-https.tls.certresolver": "myresolver",
                "traefik.http.middlewares.auth-dashboard.basicauth.users": "admin:$$2y$$05$$abc",
            },
        },
        "authorization-handler": {
            "build": {"context": str(repo)},
            "expose": ["8080"],
            "labels": {
                "traefik.enable": "true",
                "traefik.http.middlewares.my-auth.forwardauth.address": "http://authorization-handler:8080/validate",
                "traefik.http.middlewares.my-auth.forwardauth.authResponseHeaders": "X-User-Id,X-Tenant-Id",
                "traefik.http.middlewares.strip-fake-headers.headers.customrequestheaders.X-User-Id": "",
            },
        },
        "billing-service": {
            "build": {"context": str(repo / "txnet-backend")},
            "expose": ["3000"],
            "environment": {"PASSWORD": "a$$b"},
            "command": ["sh", "-c", "echo $$(date)"],
            "labels": {
                "traefik.enable": "true",
                "traefik.http.routers.billing-service.rule": "PathPrefix(`/api/billing`)",
                "traefik.http.routers.billing-service.entrypoints": "web,websecure",
                "traefik.http.routers.billing-service.middlewares": "strip-fake-headers,my-auth,edge-client-ip@file",
                "traefik.http.routers.billing-service.priority": "120",
                "traefik.http.routers.billing-service.service": "billing-service",
                "traefik.http.middlewares.auth-rate-limit.ratelimit.average": "100",
                "traefik.http.middlewares.auth-rate-limit.ratelimit.period": "1m",
                "traefik.http.services.billing-service.loadbalancer.server.port": "3000",
            },
        },
        "site-pwa": {
            "build": {"context": str(repo / "site-pwa")},
            "labels": {
                "traefik.enable": "true",
                "traefik.http.routers.nextjs-any.rule": "HostRegexp(`.+`)",
                "traefik.http.routers.nextjs-any.tls": "true",
                "traefik.http.routers.nextjs.rule": "Host(`panel.example`)",
                "traefik.http.routers.nextjs.tls.certresolver": "myresolver",
                "traefik.http.routers.nextjs.tls.domains[0].main": "panel.example",
                "traefik.http.middlewares.pwa-security.headers.stsSeconds": "31536000",
                "traefik.http.middlewares.pwa-security.headers.forceSTSHeader": "true",
                "traefik.http.middlewares.nextjs-compress.compress": "true",
                "traefik.http.services.nextjs.loadbalancer.server.port": "8181",
            },
        },
        "worker-service": {
            "build": {"context": str(repo / "txnet-backend")},
            "labels": {"traefik.http.routers.ignored.rule": "Host(`x`)"},
        },
    }}


def objects(files: dict) -> list:
    return [o for objs in files.values() if isinstance(objs, list) for o in objs]


def named(objs: list, kind: str, name: str) -> dict:
    return next(o for o in objs if o["kind"] == kind and o["metadata"]["name"] == name)


class TraefikTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.model = model(self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def render(self, m=None):
        return objects(render(m or self.model, self.repo, OPTIONS))

    # K9: each router label set is one IngressRoute with its match, entry points,
    # priority, middlewares (an @file one kept as named) and service port.
    def test_router_becomes_ingress_route(self):
        route = named(self.render(), "IngressRoute", "billing-service")
        self.assertEqual(route["apiVersion"], "traefik.io/v1alpha1")
        self.assertEqual(route["spec"]["entryPoints"], ["web", "websecure"])
        rule = route["spec"]["routes"][0]
        self.assertEqual((rule["match"], rule["kind"], rule["priority"]), ("PathPrefix(`/api/billing`)", "Rule", 120))
        self.assertEqual(rule["middlewares"], [{"name": "strip-fake-headers"}, {"name": "my-auth"},
                                               {"name": "edge-client-ip@file"}])
        self.assertEqual(rule["services"], [{"name": "billing-service", "port": 3000}])
        self.assertNotIn("tls", route["spec"])

    # K9: a router naming no service uses its container's one; `tls=true` and
    # a domain list carry over; the Traefik service name need not be the compose one.
    def test_implicit_service_and_tls(self):
        objs = self.render()
        any_host = named(objs, "IngressRoute", "nextjs-any")
        self.assertEqual(any_host["spec"]["routes"][0]["services"], [{"name": "site-pwa", "port": 8181}])
        self.assertEqual(any_host["spec"]["tls"], {})
        panel = named(objs, "IngressRoute", "nextjs")
        self.assertEqual(panel["spec"]["tls"], {"certResolver": "myresolver", "domains": [{"main": "panel.example"}]})

    # K9: api@internal is Traefik's own service.
    def test_internal_service(self):
        rule = named(self.render(), "IngressRoute", "dashboard-https")["spec"]["routes"][0]
        self.assertEqual(rule["services"], [{"name": "api@internal", "kind": "TraefikService"}])

    # K9: each middleware label set is one Middleware, its values typed as the CRD wants.
    def test_middlewares(self):
        objs = self.render()
        self.assertEqual(named(objs, "Middleware", "my-auth")["spec"], {"forwardAuth": {
            "address": "http://authorization-handler:8080/validate",
            "authResponseHeaders": ["X-User-Id", "X-Tenant-Id"]}})
        self.assertEqual(named(objs, "Middleware", "strip-fake-headers")["spec"],
                         {"headers": {"customRequestHeaders": {"X-User-Id": ""}}})
        self.assertEqual(named(objs, "Middleware", "auth-rate-limit")["spec"],
                         {"rateLimit": {"average": 100, "period": "1m"}})
        self.assertEqual(named(objs, "Middleware", "pwa-security")["spec"],
                         {"headers": {"stsSeconds": 31536000, "forceSTSHeader": True}})
        self.assertEqual(named(objs, "Middleware", "nextjs-compress")["spec"], {"compress": {}})

    # K9 + K5: the CRD takes basic-auth users only from a Secret; compose's `$$` is one `$`.
    def test_basic_auth_users_are_a_secret(self):
        objs = self.render()
        ref = named(objs, "Middleware", "auth-dashboard")["spec"]["basicAuth"]["secret"]
        users = base64.b64decode(named(objs, "Secret", ref)["data"]["users"]).decode()
        self.assertEqual(users, "admin:$2y$05$abc")

    # K5: compose prints a literal `$` as `$$`; the pod gets the value, and
    # Kubernetes' own `$(` expansion is still escaped in command and args.
    def test_compose_dollars_are_undone(self):
        objs = self.render()
        api = named(objs, "Deployment", "billing-service")["spec"]["template"]["spec"]["containers"][0]
        secret = named(objs, "Secret", api["envFrom"][0]["secretRef"]["name"])
        self.assertEqual(base64.b64decode(secret["data"]["PASSWORD"]).decode(), "a$b")
        self.assertEqual(api["args"], ["sh", "-c", "echo $$(date)"])

    # K4 + K9: Traefik calls a backend on its load-balancer port, so the Service
    # carries it even when nothing else calls the container.
    def test_backend_port_is_on_the_service(self):
        svc = named(self.render(), "Service", "site-pwa")
        self.assertEqual([p["port"] for p in svc["spec"]["ports"]], [8181])

    # K9: a router of a container Traefik does not watch renders nothing.
    def test_disabled_container_has_no_routes(self):
        self.assertFalse([o for o in self.render() if o["metadata"]["name"] == "ignored"])

    # K9: Traefik reads the CRDs, not the Docker socket, as its service account;
    # its LoadBalancer keeps the client address; the baked directories and the
    # socket are not mounted, ACME storage is claim `letsencrypt`.
    def test_the_traefik_pod(self):
        objs = self.render()
        pod = named(objs, "Deployment", TRAEFIK)["spec"]["template"]["spec"]
        args = pod["containers"][0]["args"]
        self.assertFalse([a for a in args if a.startswith("--providers.docker")])
        self.assertIn("--providers.kubernetescrd=true", args)
        self.assertIn("--providers.file.directory=/etc/traefik/dynamic", args)
        self.assertEqual(pod["serviceAccountName"], "traefik-ingress-controller")
        self.assertEqual([m["mountPath"] for m in pod["containers"][0]["volumeMounts"]], ["/letsencrypt"])
        self.assertEqual(named(objs, "PersistentVolumeClaim", "letsencrypt")["spec"]["accessModes"],
                         ["ReadWriteOnce"])
        public = named(objs, "Service", f"{TRAEFIK}-public")["spec"]
        self.assertEqual((public["type"], public["externalTrafficPolicy"]), ("LoadBalancer", "Local"))

    # K2: an unknown label is an error, never a dropped route.
    def test_unknown_labels_fail(self):
        for key in ("traefik.http.routers.billing-service.observability.metrics",
                    "traefik.http.middlewares.x.retry.attempts", "traefik.tcp.routers.x.rule"):
            broken = copy.deepcopy(self.model)
            broken["services"]["billing-service"]["labels"][key] = "1"
            with self.assertRaisesRegex(RenderError, "billing-service"):
                self.render(broken)

    # K4: a router naming a service nobody defines, or a ForwardAuth address
    # on a port its host does not expose, fails at render time.
    def test_unresolved_calls_fail(self):
        broken = copy.deepcopy(self.model)
        broken["services"]["billing-service"]["labels"]["traefik.http.routers.billing-service.service"] = "nope"
        with self.assertRaisesRegex(RenderError, "billing-service.*nope"):
            self.render(broken)
        broken = copy.deepcopy(self.model)
        broken["services"]["authorization-handler"]["expose"] = ["9000"]
        with self.assertRaisesRegex(RenderError, "authorization-handler:8080"):
            self.render(broken)


# The fixture the row names: every router of the real compose model is one
# IngressRoute, and every reference in one resolves. Needs docker compose.
@unittest.skipUnless(shutil.which("docker") and (REPO / ".env").exists() and (REPO / ".env.prod").exists(),
                     "needs docker compose and the repo's .env / .env.prod")
class RepoTraefikTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(REPO / "tools"))
        import k8s_render
        cls.model = k8s_render.load_model(k8s_render.DEFAULT_ENV_FILES, {})
        cls.objects = objects(render(cls.model, REPO, OPTIONS))

    def label_sets(self, kind: str) -> set:
        found = set()
        for service in self.model["services"].values():
            labels = service.get("labels") or {}
            if labels.get("traefik.enable") == "true":
                found |= {k.split(".")[3] for k in labels if k.startswith(f"traefik.http.{kind}.")}
        return found

    def names(self, kind: str) -> set:
        return {o["metadata"]["name"] for o in self.objects if o["kind"] == kind}

    def test_every_router_is_an_ingress_route(self):
        self.assertTrue(self.label_sets("routers"))
        self.assertEqual(self.names("IngressRoute"), self.label_sets("routers"))
        self.assertEqual(self.names("Middleware"), self.label_sets("middlewares"))

    def test_every_reference_resolves(self):
        ports = {o["metadata"]["name"]: {p["port"] for p in o["spec"]["ports"]}
                 for o in self.objects if o["kind"] == "Service"}
        for route in (o for o in self.objects if o["kind"] == "IngressRoute"):
            for rule in route["spec"]["routes"]:
                for mw in rule.get("middlewares", []):
                    self.assertTrue("@" in mw["name"] or mw["name"] in self.names("Middleware"), mw)
                for svc in rule["services"]:
                    if svc.get("kind") != "TraefikService":
                        self.assertIn(svc["port"], ports.get(svc["name"], set()), route["metadata"]["name"])


if __name__ == "__main__":
    unittest.main()
