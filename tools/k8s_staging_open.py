#!/usr/bin/env python3
"""`staging.sh open`: the owner's browser in staging (hosting R17, ADR-0168
point 3, OPS-1-ah-i).

A proxy on this host's loopback, which the owner reaches by `ssh -L`. Each
`CONNECT host:443` is answered with a certificate for that host from staging's
own CA, and sent to staging's Traefik (a `kubectl port-forward`, as the smoke
check's) by the host's own SNI, presenting the origin-pull pair Traefik requires
(O3). Its only upstream is staging: a browser set to it reaches nothing else.
The panel sends HSTS, so a certificate cannot be clicked past: the owner trusts
the CA once, in a browser profile kept for staging.
"""
import datetime
import functools
import json
import os
import re
import select
import shutil
import socket
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import k8s_release  # noqa: E402
import k8s_secrets  # noqa: E402
import k8s_staging as ks  # noqa: E402
import k8s_staging_scrub as sc  # noqa: E402
from k8srender.sealed import ORIGIN_PULL_CLIENT_DIR, ORIGIN_PULL_CLIENT_PAIR  # noqa: E402

# Kept across `down`: the owner's browser trusts it once.
CA_DIR = Path("/var/lib/txnet/staging-ca")
CA_CERT, CA_KEY = "ca.crt", "ca.key"
CA_NAME = "TXNet staging (dev host only)"
CA_DAYS, HOST_DAYS = 3650, 30
# A certificate valid from a little before now: the owner's clock may be behind.
CLOCK_SKEW = datetime.timedelta(hours=1)
LISTEN, DEFAULT_PORT = "127.0.0.1", 8443
HTTPS_PORT = 443
BUFFER = 65536
FORWARD_CHECK_S = 5
CONNECT = re.compile(r"^CONNECT ([A-Za-z0-9.-]+):443 HTTP/1\.[01]$")
PLAIN = re.compile(r"^[A-Z]+ http://([A-Za-z0-9.-]+)(?::\d+)?(\S*) HTTP/1\.[01]$")
HOST_RULE = re.compile(r"Host\(`([^`]+)`\)")


def _write_private(path: Path, data: bytes) -> None:
    with open(os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600), "wb") as f:
        f.write(data)


def _pem_key(key) -> bytes:
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


class Ca:
    """Staging's CA: the certificates the owner's browser sees, signed on demand."""

    def __init__(self, cert: x509.Certificate, key):
        self.cert, self.key = cert, key
        self.leaf_key = ec.generate_private_key(ec.SECP256R1())
        self.issued: dict[str, tuple[Path, Path]] = {}
        self.lock = threading.Lock()

    @property
    def cert_pem(self) -> bytes:
        return self.cert.public_bytes(serialization.Encoding.PEM)

    @classmethod
    def load_or_make(cls, where: Path) -> "Ca":
        cert_file, key_file = where / CA_CERT, where / CA_KEY
        if cert_file.exists() and key_file.exists():
            return cls(x509.load_pem_x509_certificate(cert_file.read_bytes()),
                       serialization.load_pem_private_key(key_file.read_bytes(), None))
        where.mkdir(parents=True, exist_ok=True, mode=0o700)
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, CA_NAME)])
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now - CLOCK_SKEW)
                .not_valid_after(now + datetime.timedelta(days=CA_DAYS))
                .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
                .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False,
                                             key_encipherment=False, data_encipherment=False, key_agreement=False,
                                             key_cert_sign=True, crl_sign=True, encipher_only=False,
                                             decipher_only=False), critical=True)
                .sign(key, hashes.SHA256()))
        _write_private(key_file, _pem_key(key))
        cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        return cls(cert, key)

    def issue(self, name: str, work: Path) -> tuple[Path, Path]:
        """(certificate, key) files for `name`, signed by this CA, made once per run."""
        with self.lock:
            if name not in self.issued:
                self.issued[name] = self._issue(name, work)
            return self.issued[name]

    def _issue(self, name: str, work: Path) -> tuple[Path, Path]:
        now = datetime.datetime.now(datetime.timezone.utc)
        builder = (x509.CertificateBuilder()
                   .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)]))
                   .issuer_name(self.cert.subject).public_key(self.leaf_key.public_key())
                   .serial_number(x509.random_serial_number()).not_valid_before(now - CLOCK_SKEW)
                   .not_valid_after(now + datetime.timedelta(days=HOST_DAYS))
                   .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH,
                                                         ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False))
        if re.fullmatch(r"[A-Za-z0-9.-]+", name):
            builder = builder.add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
        stem = work / re.sub(r"[^A-Za-z0-9.-]", "_", name)
        cert_file, key_file = stem.with_suffix(stem.suffix + ".pem"), stem.with_suffix(stem.suffix + ".key")
        _write_private(key_file, _pem_key(self.leaf_key))
        _write_private(cert_file, builder.sign(self.key, hashes.SHA256()).public_bytes(serialization.Encoding.PEM))
        return cert_file, key_file


def connect_target(line: str) -> str | None:
    """The host of a `CONNECT host:443`; None for anything else."""
    match = CONNECT.match(line)
    return match.group(1).lower() if match else None


def https_location(line: str) -> str | None:
    """Where a plain-http request of the browser's is sent instead."""
    match = PLAIN.match(line)
    return f"https://{match.group(1).lower()}{match.group(2) or '/'}" if match else None


def pipe(a: ssl.SSLSocket, b: ssl.SSLSocket) -> None:
    """Bytes both ways until either side closes. pending(): TLS may hold a
    decrypted record that select cannot see."""
    peer = {a: b, b: a}
    while True:
        ready = [s for s in peer if s.pending()] or select.select(list(peer), [], [])[0]
        for sock in ready:
            data = sock.recv(BUFFER)
            if not data:
                return
            peer[sock].sendall(data)


class Tunnel(socketserver.StreamRequestHandler):
    """One browser connection: CONNECT, then TLS on both legs, then bytes."""

    def handle(self):
        line = self.rfile.readline(BUFFER).decode("latin-1").strip()
        while self.rfile.readline(BUFFER) not in (b"\r\n", b"\n", b""):
            pass
        host = connect_target(line)
        if not host:
            location = https_location(line)
            status = f"301 Moved Permanently\r\nLocation: {location}" if location else "405 Method Not Allowed"
            self.wfile.write(f"HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".encode())
            return
        self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        proxy: Proxy = self.server
        upstream = socket.create_connection(("127.0.0.1", proxy.upstream))
        with proxy.browser_context(host).wrap_socket(self.request, server_side=True) as browser, \
                proxy.upstream_context.wrap_socket(upstream, server_hostname=host) as staging:
            pipe(browser, staging)


class Proxy(socketserver.ThreadingTCPServer):
    """The owner's way in: every tunnel goes to `upstream`, staging's Traefik."""
    daemon_threads = allow_reuse_address = True

    def __init__(self, address, ca: Ca, work: Path, upstream: int, pull_pair: tuple[Path, Path]):
        super().__init__(address, Tunnel)
        self.ca, self.work, self.upstream, self.pull_pair = ca, work, upstream, pull_pair
        self.contexts: dict[str, ssl.SSLContext] = {}

    def browser_context(self, host: str) -> ssl.SSLContext:
        if host not in self.contexts:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(*self.ca.issue(host, self.work))
            ctx.set_alpn_protocols(["http/1.1"])
            self.contexts[host] = ctx
        return self.contexts[host]

    @functools.cached_property
    def upstream_context(self) -> ssl.SSLContext:
        """Traefik's certificate is the Origin CA's (O13), unverified as the smoke
        check's curl -k; ours is the pull pair, which it verifies."""
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
        ctx.load_cert_chain(*self.pull_pair)
        ctx.set_alpn_protocols(["http/1.1"])
        return ctx

    def handle_error(self, request, client_address):
        print(f"open: a tunnel ended: {sys.exc_info()[1]!r}")


def instructions(port: int, hosts: list[str], ca_dir: Path) -> str:
    lines = [f"staging is open on {LISTEN}:{port} of this host. On your computer:",
             f"  1. ssh -N -L {port}:{LISTEN}:{port} root@<this host>",
             f"  2. scp root@<this host>:{ca_dir / CA_CERT} txnet-staging-ca.crt",
             "  3. a browser profile kept for staging (Firefox: about:profiles), with its",
             f"     HTTP proxy {LISTEN} port {port}, used for HTTPS too, and",
             "     txnet-staging-ca.crt imported as a trusted authority (once; it is kept)",
             "  4. open, in that profile only:"]
    lines += [f"       https://{host}" for host in sorted(set(hosts))]
    lines.append("Everything that profile asks for goes to staging, and nothing to the internet. Ctrl-C closes it.")
    return "\n".join(lines)


def staging_hosts(kubectl: str) -> list[str]:
    """The hosts staging's routes name, and the tenants' panel domains in its copy."""
    routes = json.loads(subprocess.run([kubectl, "get", "ingressroute", "-A", "-o", "json"], check=True,
                                       text=True, capture_output=True).stdout)["items"]
    hosts = {h for r in routes for route in r["spec"]["routes"] for h in HOST_RULE.findall(route["match"])}
    domains = sc.psql("SELECT \"domainValue\" FROM tenant.tenant_domain WHERE purpose = 'panel';").split()
    return sorted(hosts | set(domains))


def pull_pair(work: Path) -> tuple[Path, Path]:
    """The origin-pull pair, opened with production's key (linked while staging
    holds its data) into `work`, which is in memory."""
    files = []
    for name in ORIGIN_PULL_CLIENT_PAIR:
        try:
            data = k8s_secrets.opened(f"{ORIGIN_PULL_CLIENT_DIR}/{name}")
        except subprocess.CalledProcessError:
            raise ks.StagingError("the origin-pull pair does not open: staging holds no production data "
                                  "(`restore` or `twin` first)") from None
        _write_private(work / name, data)
        files.append(work / name)
    return files[0], files[1]


def open_staging(docker, port: int = DEFAULT_PORT) -> None:
    if docker(["docker", "inspect", ks.CONTAINER], check=False).returncode != 0:
        raise ks.StagingError("staging is not up: `up`, then `restore` or `twin`")
    kubectl = str(ks.KUBECTL_WRAPPER)
    work = Path(tempfile.mkdtemp(prefix="txnet-staging-open.", dir="/dev/shm"))
    forwarding = None
    try:
        pair = pull_pair(work)
        forwarding, ports = k8s_release.forward(kubectl)
        proxy = Proxy((LISTEN, port), Ca.load_or_make(CA_DIR), work, ports["https"], pair)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        print(instructions(port, staging_hosts(kubectl), CA_DIR), flush=True)
        while True:
            time.sleep(FORWARD_CHECK_S)
            if forwarding.poll() is not None:  # a port-forward ends now and then; the proxy stays
                forwarding, ports = k8s_release.forward(kubectl)
                proxy.upstream = ports["https"]
                print("open: the forward to Traefik ended and was opened again", flush=True)
    except KeyboardInterrupt:
        print("\nstaging is closed to the browser")
    finally:
        if forwarding:
            forwarding.terminate()
        shutil.rmtree(work, ignore_errors=True)
