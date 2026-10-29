#!/usr/bin/env python3
"""Staging's people scrubbed before any service starts (hosting R16, ADR-0168
point 1, OPS-1-ah-g): every phone, email, Telegram/Bale chat id and payment
detail in production's copy replaced by a fake, so no real person is reached.

Run by `k8s_staging_scrub.py scrub` after the panels, inside B10's restore:
- Postgres: each column in COLUMNS rewritten, `identity.otp_code` emptied;
- Redis: the keys that name a chat, a phone or an email deleted;
- RabbitMQ: the queued messages the restore would publish back dropped (they
  were addressed to real people).
The guard counts what in each column is not a fake, and refuses a text column
whose name says contact but which COLUMNS does not list.
"""
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Past Telegram's 52-bit user ids and still a safe JS integer: no real chat has one.
FAKE_CHAT_BASE = 9_000_000_000_000_000
# The ADR's 0912000xxxx, as the column stores it (E.164).
FAKE_PHONE = "'+98912' || lpad(n::text, 7, '0')"
FAKE_EMAIL = "'user' || n || '@staging.invalid'"
FAKE_CHAT = f"({FAKE_CHAT_BASE} + n)::text"
FAKE_WALLET = "staging-wallet-0000000000"
# A manual destination's personal fields (billing payment/manual/kinds): the card
# passes Luhn and the sheba mod 97, so an edit in staging validates.
DESTINATION_FAKES = {"cardNumber": "6037990000000006", "sheba": "IR490000000000000000000000",
                     "holderName": "Staging Holder", "address": FAKE_WALLET, "memo": "staging"}
# The wiped panel address of R16 (k8s_staging_scrub.WIPED_ADDRESS), as an origin.
WIPED_ORIGIN = "http://192.0.2.1"


def is_phone(c: str, table: str) -> str:
    return f"\"{c}\" ~ '^\\+98912[0-9]{{7}}$' AND substr(\"{c}\", 7)::int <= (SELECT count(*) FROM {table})"


def is_email(c: str) -> str:
    return f"\"{c}\" ~ '^user[0-9]+@staging\\.invalid$'"


def is_chat(c: str) -> str:
    return f"\"{c}\" ~ '^[0-9]{{16}}$' AND \"{c}\"::numeric > {FAKE_CHAT_BASE}"


def destination_fake(c: str) -> str:
    pairs = ", ".join(f"'{k}', CASE WHEN \"{c}\" ? '{k}' THEN '{v}' END" for k, v in DESTINATION_FAKES.items())
    return f'"{c}" || jsonb_strip_nulls(jsonb_build_object({pairs}))'


def destination_is_fake(c: str) -> str:
    return " AND ".join(f"coalesce(\"{c}\"->>'{k}', '{v}') = '{v}'" for k, v in DESTINATION_FAKES.items())


@dataclass(frozen=True)
class Column:
    """One column of a person's contact: its fake (SQL over the row's number `n`)
    and the test that a value is one of ours."""
    table: str
    column: str
    fake: str
    is_fake: str
    unique: bool = False

    @property
    def name(self) -> str:
        return f"{self.table}.{self.column}"


def _phone(table, column, unique=False):
    return Column(table, column, FAKE_PHONE, is_phone(column, table), unique)


def _email(table, column, unique=False):
    return Column(table, column, FAKE_EMAIL, is_email(column), unique)


def _destination(table, column):
    return Column(table, column, destination_fake(column), destination_is_fake(column))


COLUMNS = (
    _phone('identity."user"', "phoneNumber", unique=True),
    _email('identity."user"', "email", unique=True),
    _phone("identity.linked_bot_account", "phoneNumber"),
    Column("identity.linked_bot_account", "platformUserId", FAKE_CHAT, is_chat("platformUserId"), unique=True),
    Column("billing.payment_transaction", "payerChatId", FAKE_CHAT, is_chat("payerChatId")),
    Column("billing.payment_transaction", "cardPanMasked", "'000000******0000'",
           "\"cardPanMasked\" = '000000******0000'"),
    _destination("billing.manual_destination", "fields"),
    _destination("billing.payment_transfer_detail", "destinationSnapshot"),
    Column("billing.crypto_payment_detail", "depositAddress", f"'{FAKE_WALLET}'", f"\"depositAddress\" = '{FAKE_WALLET}'"),
    _phone("tenant.tenant_branding", "supportPhone"),
    _email("tenant.tenant_branding", "supportEmail"),
    Column("entitlement.migration_item", "telegramLink", "NULL", "false"),
    # A migration's source panel, dialed by its import: R16's wiped address.
    Column("entitlement.migration_run", "sourceAddress", f"'{WIPED_ORIGIN}'", f"\"sourceAddress\" = '{WIPED_ORIGIN}'"),
)
CLEARED = ("identity.otp_code",)
# What a column name says when it holds a contact; read over text, json and array columns.
CONTACT_NAME = re.compile(r"phone|mail|chat|telegram|bale|card|iban|sheba|holder|mobile|msisdn|address|wallet",
                          re.IGNORECASE)
# Columns whose name matches and that are no person's contact, each with why.
NOT_CONTACT = {
    "identity.otp_code.phoneNumber", "identity.otp_code.email",  # the table is emptied
    "identity.session.ipAddress", "audit.admin_audit_log.adminIpAddress",  # where a request came from
    "audit.impersonation_session.adminIpAddress", "network.ip_access_rule.ipAddressOrCidr",
    "billing.payment_transaction.payerChatPlatform",  # `telegram` / `bale`, not who
    "ai.reader_reseller.walletCurrency",
    # R16's: the panels' own addresses, and their drift history (never dialed)
    "network.panel.ipAddress", "network.panel.knownAddresses",
    "network.panel_drift_event.knownAddresses", "network.panel_drift_event.seenAddresses",
}
# Redis families that name a chat (bot-keys.ts) or a phone (keys.ts otp*), after
# the client's own prefix (`txnet:auth:v2:`), and any key with a segment that is
# a phone (+98…), a chat id (digits alone) or an email. Exact segments: a UUID's
# digit run is no chat, and an outbox `processed` key deleted is a notice sent twice.
PERSONAL_PREFIXES = ("bot:", "botlink:", "otp:")
CLIENT_PREFIX = re.compile(r"^txnet:[a-z-]+:v\d+:")
PERSONAL_SEGMENT = re.compile(r"^(\+\d{10,}|\d{6,}|[^@\s]+@[^@\s]+\.[a-z]+)$", re.IGNORECASE)


def qident(column: str) -> str:
    return f'"{column}"'


def scrub_sql() -> str:
    """One transaction. A unique column is moved aside first (`~` + itself), so a
    fake never meets a row not yet rewritten."""
    lines = ["BEGIN;"]
    for c in COLUMNS:
        col = qident(c.column)
        if c.unique:
            lines.append(f"UPDATE {c.table} SET {col} = '~' || {col} WHERE {col} IS NOT NULL;")
        lines.append(f"UPDATE {c.table} SET {col} = {c.fake} FROM (SELECT ctid AS row, row_number() OVER () AS n "
                     f"FROM {c.table} WHERE {col} IS NOT NULL) s WHERE {c.table}.ctid = s.row;")
    lines += [f"DELETE FROM {table};" for table in CLEARED]
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


def guard_sql() -> str:
    """One row of JSON: {column or table: how many of its values are not ours}."""
    parts = [f"'{c.name}', (SELECT count(*) FROM {c.table} WHERE {qident(c.column)} IS NOT NULL "
             f"AND NOT ({c.is_fake}))" for c in COLUMNS]
    parts += [f"'{table}', (SELECT count(*) FROM {table})" for table in CLEARED]
    return f"SELECT jsonb_build_object({', '.join(parts)});"


COLUMNS_SQL = ("SELECT jsonb_agg(jsonb_build_array(table_schema, table_name, column_name)) "
               "FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') "
               "AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY');")


def unknown_columns(columns) -> list[str]:
    """Text columns named like a contact that neither COLUMNS nor NOT_CONTACT lists."""
    known = {c.name.replace('"', "") for c in COLUMNS} | NOT_CONTACT
    names = (f"{schema}.{table}.{column}" for schema, table, column in columns if CONTACT_NAME.search(column))
    return sorted(n for n in names if n not in known)


def findings(counts: dict[str, int], unknown: list[str]) -> list[str]:
    lines = [f"{name}: {count} value(s) not a fake" for name, count in counts.items() if count]
    return lines + [f"{name}: names a contact the scrub does not know (add it to COLUMNS or NOT_CONTACT)"
                    for name in unknown]


def personal_keys(keys) -> list[str]:
    def personal(key: str) -> bool:
        name = CLIENT_PREFIX.sub("", key)
        return name.startswith(PERSONAL_PREFIXES) or any(PERSONAL_SEGMENT.match(part) for part in name.split(":"))
    return [k for k in keys if personal(k)]


def drop_queued(work: Path) -> int:
    """The restore's queued messages emptied; returns how many there were."""
    path = work / "rabbitmq" / "messages.json"
    if not path.exists():
        return 0
    count = len(json.loads(path.read_text()))
    path.write_text("[]")
    return count


# Redis renames its process, so its password is read from the StatefulSet and
# handed over as stdin's first line: never on a command line, ours or the pod's.
REDIS_AUTH = 'IFS= read -r pw; export REDISCLI_AUTH="$pw"; '


def redis_password(kubectl: list[str]) -> str:
    args = json.loads(subprocess.run([*kubectl, "get", "statefulset", "memory-data", "-o",
                                      "jsonpath={.spec.template.spec.containers[0].args}"],
                                     check=True, text=True, capture_output=True).stdout)
    return args[args.index("--requirepass") + 1]


def redis(kubectl: list[str], password: str, script: str, stdin: str = "") -> str:
    argv = [*kubectl, "exec", "-i", "memory-data-0", "-c", "memory-data", "--", "sh", "-c", REDIS_AUTH + script]
    return subprocess.run(argv, input=f"{password}\n{stdin}", check=True, text=True, capture_output=True).stdout


def scrub(psql, kubectl: list[str], work: Path | None) -> None:
    psql(scrub_sql())
    password = redis_password(kubectl)
    keys = personal_keys(redis(kubectl, password, "redis-cli --no-auth-warning --scan").splitlines())
    if keys:
        redis(kubectl, password, "tr '\\n' '\\0' | xargs -0 -r -n 500 redis-cli --no-auth-warning unlink >/dev/null",
              stdin="\n".join(keys) + "\n")
    dropped = drop_queued(work) if work else 0
    print(f"people: {len(COLUMNS)} columns faked, {len(CLEARED)} table emptied, "
          f"{len(keys)} Redis keys and {dropped} queued messages dropped")


def guard(psql) -> list[str]:
    counts = json.loads(psql(guard_sql()).strip())
    columns = json.loads(psql(COLUMNS_SQL).strip() or "null") or []
    return findings(counts, unknown_columns(columns))
