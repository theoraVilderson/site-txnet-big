#!/usr/bin/env python3
"""Staging's copy of production, scrubbed before any service starts (hosting R14,
ADR-0168 points 1, 2, OPS-1-ah-f).

B10's restore runs this between the stores and the services (`backup.py restore
--scrub`), so nothing of staging ever reads a real panel's row:

    scrub --prod-host HOST   each panel on production's server pointed at its
                             local copy (/root/paneltest: same panels, same
                             logins); every other one wiped — addresses, login,
                             vault rows, OpenVPN file — and archived, which
                             stops its collection; then `guard`
                             then the people (`k8s_staging_people.py`, OPS-1-ah-g)
                             and the keys (`k8s_staging_keys.py`, OPS-1-ah-h), and
                             the services aimed at the bots' gate (OPS-1-ah-j)
    guard                    exit 1, naming each, while a panel row names an
                             address that is not a local panel, a person's
                             contact is not a fake, or a key is not staging's

The closed network stays the other layer (ADR-0168 point 2): one mistake in
either reaches nothing real.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import k8s_staging as ks  # noqa: E402
import k8s_staging_gate as kg  # noqa: E402
import k8s_staging_keys as kk  # noqa: E402
import k8s_staging_people as kp  # noqa: E402

MAIN_DB_POD, MAIN_DB_CONTAINER = "main-db-0", "main-db"
NAMESPACE = "txnet"
KUBECTL = [str(ks.KUBECTL_WRAPPER), "-n", NAMESPACE]
# B10's restore names the opened bundle here (bundle_restore.RESTORE_WORK).
RESTORE_WORK = "TXNET_RESTORE_WORK"
# TEST-NET-1 (RFC 5737), routed nowhere: what a wiped panel's NOT NULL address
# columns hold (`panel_pull_has_base_url`, `panel_push_has_ip_address`). The URL
# ends in the panel's id: `panel_api_address_key` holds one panel per address.
WIPED_ADDRESS = "192.0.2.1"
WIPED_URL = f"http://{WIPED_ADDRESS}/wiped/"
# The panel columns that name where it is; a new one is added here and to the
# guard in the same change (ADR-0168, consequences).
URL_FIELDS = ("apiBaseUrl", "clientBaseUrl")
PANEL_FIELDS = ("id", "name", *URL_FIELDS, "ipAddress", "knownAddresses", "ovpnProfile",
                "panelApiCredentials", "panelRadiusSecret", "retiredAt")
# shared-core's panelCredentialLabel / panelRadiusSecretLabel: `panel:<id>`, `panel:<id>:radius`.
LOGIN_KIND, SOURCE_LOGIN_KIND = "panel_credentials", "source_panel_credentials"


@dataclass
class Local:
    """The local panels on staging's network: {published port: (address, container port)}."""
    ports: dict[str, tuple[str, str]] = field(default_factory=dict)

    @property
    def addresses(self) -> set[str]:
        return {address for address, _ in self.ports.values()}

    @classmethod
    def from_inspect(cls, inspect_json: str) -> "Local":
        """From `docker inspect` of the paneltest containers."""
        ports = {}
        for container in json.loads(inspect_json):
            address = container["NetworkSettings"]["Networks"].get(ks.NETWORK, {}).get("IPAddress")
            for inner, bindings in (container["HostConfig"].get("PortBindings") or {}).items():
                port, _, proto = inner.partition("/")
                if address and proto == "tcp":
                    ports.update({b["HostPort"]: (address, port) for b in bindings or []})
        return cls(ports)

    @classmethod
    def running(cls, docker) -> "Local":
        names = ks.paneltest_containers(docker)
        if not names:
            print("no local panel is running (`docker compose -p paneltest up -d` in /root/paneltest): "
                  "every panel is wiped")
            return cls()
        return cls.from_inspect(docker(["docker", "inspect", *names]).stdout)


def repoint(url: str | None, prod_host: str, local: Local) -> str | None:
    """url moved to its local copy, or None when it names no test panel of production's server."""
    if not url:
        return None
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "http" or parts.hostname != prod_host or str(parts.port) not in local.ports:
        return None
    address, port = local.ports[str(parts.port)]
    return urllib.parse.urlunsplit(parts._replace(netloc=f"{address}:{port}"))


def plan(rows: list[dict], prod_host: str, local: Local) -> tuple[dict[str, dict], list[str]]:
    """({id: new address columns} of the panels pointed, [ids wiped]). An archived
    panel is wiped wherever it is: nothing in staging collects from it."""
    pointed, wiped = {}, []
    for row in rows:
        api = None if row["retiredAt"] else repoint(row["apiBaseUrl"], prod_host, local)
        if not api:
            wiped.append(row["id"])
            continue
        address = urllib.parse.urlsplit(api).hostname
        pointed[row["id"]] = {"apiBaseUrl": api, "clientBaseUrl": repoint(row["clientBaseUrl"], prod_host, local),
                              "ipAddress": address if row["ipAddress"] else None}
    return pointed, wiped


def sql_text(value: str | None) -> str:
    return "NULL" if value is None else "'" + value.replace("'", "''") + "'"


def panels_sql(pointed: dict[str, dict]) -> str:
    """One transaction: the pointed panels' new addresses, every other panel wiped
    and archived, and every login in the vault but the pointed panels' gone."""
    kept = ", ".join(sql_text(label) for pid in pointed for label in (f"panel:{pid}", f"panel:{pid}:radius"))
    ids = ", ".join(sql_text(pid) for pid in pointed)
    lines = ["BEGIN;"]
    lines += [f'UPDATE network.panel SET "apiBaseUrl" = {sql_text(c["apiBaseUrl"])}, '
              f'"clientBaseUrl" = {sql_text(c["clientBaseUrl"])}, "ipAddress" = {sql_text(c["ipAddress"])}, '
              f"\"knownAddresses\" = '{{}}', \"ovpnProfile\" = NULL WHERE id = {sql_text(pid)};"
              for pid, c in pointed.items()]
    lines.append(f'UPDATE network.panel SET "apiBaseUrl" = CASE WHEN "apiBaseUrl" IS NULL THEN NULL '
                 f'ELSE {sql_text(WIPED_URL)} || id END, "clientBaseUrl" = NULL, "ipAddress" = CASE WHEN "ipAddress" '
                 f'IS NULL THEN NULL ELSE {sql_text(WIPED_ADDRESS)} END, "knownAddresses" = \'{{}}\', '
                 f'"ovpnProfile" = NULL, "panelApiCredentials" = \'\', "panelRadiusSecret" = NULL, '
                 f'"retiredAt" = coalesce("retiredAt", now())'
                 + (f" WHERE id NOT IN ({ids});" if ids else ";"))
    lines.append(f"DELETE FROM tenant.tenant_credential WHERE kind = {sql_text(SOURCE_LOGIN_KIND)} "
                 f"OR (kind = {sql_text(LOGIN_KIND)}" + (f" AND label NOT IN ({kept}));" if kept else ");"))
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


def host_of(value: str) -> str | None:
    return urllib.parse.urlsplit(value).hostname if "://" in value else value


def offenders(rows: list[dict], local: Local, vault_labels: list[str], source_logins: int = 0) -> list[str]:
    """What of production's is still reachable in the copy, one line each."""
    allowed = local.addresses | {WIPED_ADDRESS}
    found, live_labels = [], set()
    for row in rows:
        named = [(f, row[f]) for f in (*URL_FIELDS, "ipAddress") if row[f] and host_of(row[f]) not in allowed]
        named += [("knownAddresses", a) for a in row["knownAddresses"] if a not in local.addresses]
        named += [("ovpnProfile", "its OpenVPN file")] if row["ovpnProfile"] else []
        found += [f"{row['name']} ({row['id']}): {f} names {value}" for f, value in named]
        if named or (row["apiBaseUrl"] and host_of(row["apiBaseUrl"]) in local.addresses):
            live_labels.update((f"panel:{row['id']}", f"panel:{row['id']}:radius"))
            continue
        # Wiped: archived, with no login in the row.
        if row["panelApiCredentials"] or row["panelRadiusSecret"]:
            found.append(f"{row['name']} ({row['id']}): wiped but still holds its login")
        elif not row["retiredAt"]:
            found.append(f"{row['name']} ({row['id']}): wiped but still in service")
    # The vault holds a login only for a local panel: one of a wiped or deleted
    # panel is a real one (the dev dry run found a deleted panel's).
    stray = sorted({label for label in vault_labels if label not in live_labels})
    if stray:
        found.append(f"the vault holds {len(stray)} login(s) of no local panel: {', '.join(stray)}")
    if source_logins:
        found.append(f"the vault holds {source_logins} source panel login(s) of a migration")
    return found


def psql(sql: str) -> str:
    """sql in main-db as its own user; small statements only (B10: large stdin truncates)."""
    argv = [*KUBECTL, "exec", "-i", MAIN_DB_POD, "-c", MAIN_DB_CONTAINER, "--",
            "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1']
    return subprocess.run(argv, input=sql, check=True, text=True, capture_output=True).stdout


def read_json(query: str) -> list:
    return json.loads(psql(f"SELECT coalesce(jsonb_agg(r), '[]') FROM ({query}) r;").strip() or "[]")


def panel_rows() -> list[dict]:
    columns = ", ".join(f'"{c}"' for c in PANEL_FIELDS)
    return read_json(f"SELECT {columns} FROM network.panel")


def vault_logins() -> tuple[list[str], int]:
    rows = read_json(f"SELECT kind, label FROM tenant.tenant_credential "
                     f"WHERE kind IN ({sql_text(LOGIN_KIND)}, {sql_text(SOURCE_LOGIN_KIND)})")
    return [r["label"] for r in rows if r["kind"] == LOGIN_KIND], sum(r["kind"] == SOURCE_LOGIN_KIND for r in rows)


def guard(local: Local) -> bool:
    """True when no panel row names a real address, every person's contact is a
    fake and every key staging's own; each finding said otherwise."""
    labels, sources = vault_logins()
    found = offenders(panel_rows(), local, labels, sources) + kp.guard(psql) + kk.guard(psql) + kg.guard(KUBECTL)
    for line in found:
        print(f"REAL  {line}")
    if found:
        print(f"{len(found)} real address(es), login(s), contact(s) or key(s) left in staging's copy: "
              "it does not start")
    return not found


def scrub_panels(docker, prod_host: str) -> Local:
    local = Local.running(docker)
    rows = panel_rows()
    pointed, wiped = plan(rows, prod_host, local)
    psql(panels_sql(pointed))
    print(f"panels: {len(pointed)} pointed at their local copies, {len(wiped)} wiped and archived")
    return local


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["scrub", "guard"])
    parser.add_argument("--prod-host", help="scrub: production's server, whose test panels have local copies")
    args = parser.parse_args(argv)
    if args.command == "scrub" and not args.prod_host:
        parser.error("scrub needs --prod-host")
    try:
        if args.command == "scrub":
            local = scrub_panels(ks.docker_run, args.prod_host)
            work = os.environ.get(RESTORE_WORK)
            kp.scrub(psql, KUBECTL, Path(work) if work else None)
            kk.scrub(psql, KUBECTL)
            kg.aim(KUBECTL)
        else:
            local = Local.running(ks.docker_run)
        return 0 if guard(local) else 1
    except subprocess.CalledProcessError as e:
        print(f"k8s_staging_scrub.py: {' '.join(map(str, e.cmd))} failed: {(e.stderr or '').strip()}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
