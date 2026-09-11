#!/usr/bin/env python3
"""Hold Traefik and the permission file to their declarations. Exit 1 on failure.

The sixth gate (ADR-0036, C-04). `wire.json` is the declared home of every
HTTP name that crosses a process boundary; a test on each side holds Go and
TypeScript to it. Traefik is the third side, and it reads YAML — there is no
toolchain that could make it import a constant, which is why this script exists
rather than another `CONVENTIONS.md` check block. A check block matches a
regex per file and cannot say that two files agree.

Two families, one gate, because they fail the same way: a string spelled in two
languages with nothing comparing the copies.

    python3 tools/contracts.py          check
    python3 tools/contracts.py --list   print what was found, then check

THE TWO LISTS ARE DIFFERENT CONTRACTS AND ARE NOT CHECKED THE SAME WAY.
This asymmetry is the only subtle thing in here, so it is stated once, fully:

  `strip-fake-headers` (customrequestheaders.X-Foo=) is a SECURITY BOUNDARY.
  It is asserted as a SUPERSET of the declared identity headers. Stripping a
  header nothing writes is correct defence in depth, not drift — `X-Actor-Id`
  has sat in that list unwritten for months and removing it would open a
  forgeable header the day somebody adds a reader. Anything extra is fine;
  anything missing is a header a client can forge.

  `forwardauth.authResponseHeaders` is a DATA CONTRACT. It is asserted as
  EQUAL to what Go writes and TypeScript reads. A missing entry does not fail
  loudly: the header simply never arrives, `identity.ts` reads `undefined`,
  and the request proceeds as an anonymous or wrong-tenant identity. An extra
  entry is a name nothing writes, which is how a list starts to drift.

Getting those two backwards is the failure this gate exists to prevent, so if
you are editing this file, that is the paragraph to read twice.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "contracts" / "http" / "wire.json"
# Every compose/stack file that could carry Traefik labels. Scanned rather
# than named one by one so that renaming a compose file cannot silently
# disable the gate — if none of them carries the labels at all, that is an
# error, not a pass.
SEARCH = ["dev-docker/**/*.yml", "dev-docker/**/*.yaml",
          "swarm/**/*.yml", "swarm/**/*.yaml"]

PERMISSIONS = ROOT / "auth-handler" / "configs" / "permissions.yaml"
SEED = ROOT / "txnet-backend" / "prisma" / "seed.js"
# Where a permission name can legitimately be written in TypeScript. Anywhere
# else is a name nothing checks.
TS_PERMISSION_SOURCES = ["txnet-backend/**/*.ts"]
TS_PERMISSION_RE = re.compile(
    r"new PermissionsGuard\(\s*\[([^\]]*)\]", re.S)
TS_PERMISSION_CONST_RE = re.compile(
    r"_PERMISSION\s*=\s*'([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)'")
DEFAULT_ROLE_RE = re.compile(
    r"where:\s*\{\s*name:\s*'([^']+)'\s*\}")

STRIP_RE = re.compile(
    r"traefik\.http\.middlewares\.([A-Za-z0-9_-]+)"
    r"\.headers\.customrequestheaders\.([A-Za-z0-9-]+)\s*=",
    re.IGNORECASE,
)
FORWARD_RE = re.compile(
    r"traefik\.http\.middlewares\.([A-Za-z0-9_-]+)"
    r"\.forwardauth\.authresponseheaders\s*=\s*([^\"'\s]+)",
    re.IGNORECASE,
)

errors: list[str] = []


def load_fixture() -> dict:
    if not FIXTURE.exists():
        errors.append(f"{FIXTURE.relative_to(ROOT)} is missing — it is "
                      "hand-written and checked in; restore it")
        return {}
    try:
        return json.loads(FIXTURE.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"{FIXTURE.relative_to(ROOT)} is not valid JSON: {exc}")
        return {}


def names(block: dict) -> list[str]:
    """The fixture carries a `note` beside the real entries. It is prose."""
    return [v for k, v in block.items() if k != "note"]


def yaml_files() -> list[Path]:
    found: list[Path] = []
    for pattern in SEARCH:
        found.extend(sorted(ROOT.glob(pattern)))
    return found


def scan() -> tuple[dict[str, set[str]], dict[str, list[str]], dict[str, Path]]:
    """-> (strip lists by middleware, forward lists by middleware, where each
    middleware was found)."""
    strip: dict[str, set[str]] = {}
    forward: dict[str, list[str]] = {}
    where: dict[str, Path] = {}

    for path in yaml_files():
        text = path.read_text(encoding="utf-8")
        for match in STRIP_RE.finditer(text):
            middleware, header = match.group(1), match.group(2)
            strip.setdefault(middleware, set()).add(header.lower())
            where.setdefault(middleware, path)
        for match in FORWARD_RE.finditer(text):
            middleware, raw = match.group(1), match.group(2)
            listed = [h.strip().lower() for h in raw.split(",") if h.strip()]
            if middleware in forward and forward[middleware] != listed:
                errors.append(
                    f"middleware '{middleware}' declares two different "
                    f"authResponseHeaders lists across the compose files")
            forward[middleware] = listed
            where.setdefault(middleware, path)

    return strip, forward, where


def check_strip(strip: dict[str, set[str]], required: list[str]) -> None:
    """Superset. See the module docstring for why this one is not equality."""
    if not strip:
        errors.append("no `strip-fake-headers`-style customrequestheaders "
                      "labels found in any compose file — the gate cannot "
                      "have passed; check the paths in SEARCH")
        return

    for middleware, stripped in sorted(strip.items()):
        missing = [h for h in required if h.lower() not in stripped]
        if missing:
            errors.append(
                f"middleware '{middleware}' does not strip {', '.join(missing)} "
                f"— forwarded but not stripped is a header a client can forge")


def check_forward(forward: dict[str, list[str]], fixture: dict) -> None:
    """Equality. See the module docstring for why this one is not a superset."""
    if not forward:
        errors.append("no `forwardauth.authResponseHeaders` label found in any "
                      "compose file — the gate cannot have passed; check the "
                      "paths in SEARCH")
        return

    identity = [h.lower() for h in names(fixture.get("identityHeaders", {}))]
    anonymous = [h.lower() for h in names(fixture.get("gateHeaders", {}))]

    for middleware, listed in sorted(forward.items()):
        # A middleware pointing at /validate-optional also forwards the
        # anonymous marker; one pointing at /validate must not, because a
        # gate that cannot answer "nobody" has nothing to say with it.
        expected = set(identity) | (set(anonymous) if "optional" in middleware
                                    else set())
        got = set(listed)
        for header in sorted(expected - got):
            errors.append(
                f"middleware '{middleware}' does not forward {header} — the "
                f"header never arrives, and a consumer reads it as absent "
                f"rather than as an error")
        for header in sorted(got - expected):
            errors.append(
                f"middleware '{middleware}' forwards {header}, which "
                f"contracts/http/wire.json does not declare for it")
        if len(listed) != len(got):
            errors.append(f"middleware '{middleware}' lists a header twice")



# --- the permission file ----------------------------------------------------
#
# Same shape as the header contract, so it extends this gate rather than adding
# a mechanism: a name written in Go's YAML and again in TypeScript, with
# nothing comparing the two. `auth-handler` enforces the YAML as defence in
# depth, Nest enforces an inline array, and a permission in one and not the
# other is a route that is either unreachable or ungated.


def parse_permissions() -> tuple[dict[str, set[str]], list[str]]:
    """-> (role -> permissions, role names in file order).

    The same minimal parser `auth-handler/internal/auth/engine.go` uses,
    deliberately: a full YAML library here would accept files the Go side
    rejects, and then this gate would pass on a policy that never loads.
    """
    if not PERMISSIONS.exists():
        errors.append(f"{PERMISSIONS.relative_to(ROOT)} is missing — "
                      "auth-handler loads it as its RBAC policy")
        return {}, []

    roles: dict[str, set[str]] = {}
    order: list[str] = []
    current = ""
    in_perms = False

    for raw in PERMISSIONS.read_text(encoding="utf-8").splitlines():
        trimmed = raw.strip()
        if not trimmed or trimmed.startswith("#") or trimmed == "roles:":
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if indent == 2 and trimmed.endswith(":"):
            current = trimmed[:-1]
            roles[current] = set()
            order.append(current)
            in_perms = False
        elif indent == 4 and trimmed == "permissions:":
            in_perms = True
        elif indent >= 6 and trimmed.startswith("- ") and in_perms:
            roles[current].add(trimmed[2:].strip())
    return roles, order


def typescript_permissions() -> dict[str, list[str]]:
    """-> permission name -> where it is written."""
    found: dict[str, list[str]] = {}
    for pattern in TS_PERMISSION_SOURCES:
        for path in sorted(ROOT.glob(pattern)):
            if "node_modules" in path.parts or path.name.endswith(".spec.ts"):
                continue
            text = path.read_text(encoding="utf-8")
            names: list[str] = []
            for match in TS_PERMISSION_RE.finditer(text):
                names += re.findall(r"'([^']+)'", match.group(1))
            names += TS_PERMISSION_CONST_RE.findall(text)
            for name in names:
                found.setdefault(name, []).append(
                    str(path.relative_to(ROOT)))
    return found


def check_permissions() -> None:
    roles, _order = parse_permissions()
    if not roles:
        return

    granted = set().union(*roles.values()) if roles else set()
    written = typescript_permissions()
    if not written:
        errors.append("no permission name found in any TypeScript source — "
                      "the scan cannot have worked; check TS_PERMISSION_RE")
        return

    for name, where in sorted(written.items()):
        if name not in granted:
            errors.append(
                f"permission {name!r} is enforced in TypeScript "
                f"({', '.join(sorted(set(where)))}) but no role in "
                f"{PERMISSIONS.relative_to(ROOT)} grants it — auth-handler "
                f"refuses any token claiming it, so the route is unreachable")


def check_default_role() -> None:
    """The default role name is spelled in three places and must agree.

    `RegisterService` looks a role up by name, `prisma/seed.js` creates the
    rows, and `permissions.yaml` grants that name its permissions. A new user
    lands on whichever row the first spelling finds; if the third disagrees,
    every request that user makes is refused by the gateway.
    """
    roles, _ = parse_permissions()
    if not roles or not SEED.exists():
        return

    register = ROOT / ("txnet-backend/auth-service/src/app/auth/register/"
                       "register.service.ts")
    if not register.exists():
        return

    looked_up = DEFAULT_ROLE_RE.findall(register.read_text(encoding="utf-8"))
    if not looked_up:
        errors.append(f"{register.relative_to(ROOT)} no longer looks a default "
                      "role up by name — this check needs updating")
        return

    seed_text = SEED.read_text(encoding="utf-8")
    seeded = re.search(r"ROLE_NAMES\s*=\s*\[([^\]]*)\]", seed_text)
    seeded_names = re.findall(r"'([^']+)'", seeded.group(1)) if seeded else []

    # Every seeded role, not only the default: the gateway looks the token's
    # `roleName` up in the file by exact spelling, so a role the seed creates
    # and the file lacks is refused on every gated request (ADR-0037).
    for name in seeded_names:
        if name not in roles:
            errors.append(
                f"prisma/seed.js creates role {name!r}, which "
                f"{PERMISSIONS.relative_to(ROOT)} has no entry for (spelling "
                f"and case must match) — every gated request by that role "
                f"is refused by the gateway")

    for name in sorted(set(looked_up)):
        if name not in seeded_names:
            errors.append(
                f"register.service.ts looks up role {name!r}, which "
                f"prisma/seed.js never creates — registration fails with "
                f"`register.defaultRoleMissing` on a fresh database")
        if name not in roles and name not in seeded_names:
            errors.append(
                f"register.service.ts looks up role {name!r}, which "
                f"{PERMISSIONS.relative_to(ROOT)} does not grant — every "
                f"request by a newly registered user is refused by the gateway")


def main() -> int:
    show = "--list" in sys.argv

    fixture = load_fixture()
    if errors:
        for e in errors:
            print(f"ERROR {e}")
        return 1

    identity = names(fixture.get("identityHeaders", {}))
    anonymous = names(fixture.get("gateHeaders", {}))
    strip, forward, where = scan()

    if show:
        print(f"fixture: {len(identity)} identity header(s), "
              f"{len(anonymous)} gate header(s)")
        for middleware in sorted(set(strip) | set(forward)):
            origin = where.get(middleware)
            label = origin.relative_to(ROOT) if origin else "?"
            print(f"  {middleware}  ({label})")
            if middleware in strip:
                print(f"    strips   {', '.join(sorted(strip[middleware]))}")
            if middleware in forward:
                print(f"    forwards {', '.join(forward[middleware])}")

    check_strip(strip, identity + anonymous)
    check_forward(forward, fixture)
    check_permissions()
    check_default_role()

    for e in errors:
        print(f"ERROR {e}")
    roles, _ = parse_permissions()
    print(f"\ntraefik middlewares: {len(set(strip) | set(forward))}   "
          f"roles: {len(roles)}   {len(errors)} error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
