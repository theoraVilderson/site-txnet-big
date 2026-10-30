#!/usr/bin/env python3
"""Staging's keys replaced before any service starts (hosting R16, ADR-0168
point 1, OPS-1-ah-h): no real bot, SMS line or gateway key is left in the copy.

Run by `k8s_staging_scrub.py scrub` after the people, inside B10's restore:
- the vault: every key but the local panels' logins (R16's) deleted — bots,
  webhook secrets, SMS, gateways, AI, DNS — so an SMS stays queued and an online
  gateway answers "not configured" (user, 2026-10-29: no stub, no sandbox);
- bots: the platform's primary Telegram and Bale bots get the dev bots of
  `.env.dev` (the ones scripts/seed-bot-integration.sh reads), sealed under a
  new data key wrapped with the cluster's own KEK; every other bot disabled;
- gateways: the encrypted merchant id and key columns cleared.
The guard refuses a vault key that is not the dev bots', a bot in service that is
not one, a gateway key, and a column named like a key that neither KEY_COLUMNS
nor NOT_KEY lists.
"""
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts" / "bundle"))
from bundle_plan import parse_env  # noqa: E402

# vault.crypto.ts: AES-256-GCM, a 12-byte IV, the fingerprint's domain and length.
KEY_BYTES, IV_BYTES, TAG_BYTES = 32, 12, 16
FINGERPRINT_DOMAIN = b"txnet:vault:fingerprint:v1"
FINGERPRINT_HEX_CHARS = 16
# The KEK's id is its file's name (kek.service.ts), and k8s mounts it at
# VAULT_KEK_FILE=/run/secrets/vault-kek from this volume of tenant-service.
KEK_ID, KEK_VOLUME, KEK_DEPLOYMENT = "vault-kek", "secret-vault-kek", "tenant-service"
# R16's panel scrub keeps the local panels' logins; every other kind goes.
KEPT_KIND = "panel_credentials"
BOT_KINDS = {"telegram": "telegram_bot_token", "bale": "bale_bot_token"}
WEBHOOK_KIND = "webhook_secret"
WIPED = "wiped"
OWNER = "(SELECT id FROM tenant.tenant WHERE \"tenantType\" = 'platform_owner')"
# Columns that hold a third party's key, each cleared by keys_sql (or, for the
# vault, guarded by kind). A new one is added here and to keys_sql together.
KEY_COLUMNS = {
    "tenant.tenant_credential.ciphertext",
    "tenant.tenant_gateway_config.merchantIdEncrypted", "tenant.tenant_gateway_config.apiKeyEncrypted",
    "billing.payment_gateway.merchantId",
}
KEY_NAME = re.compile(r"secret|token|api_?key|merchant|encrypt|credential|password|passphrase|private|sealed"
                      r"|cipher|signing", re.IGNORECASE)
# Columns whose name matches and that hold no third party's key, each with why.
NOT_KEY = {
    "automation.bot_integration.credentialRef",  # the vault label, not the key
    # what the platform itself issued: a person's sign-in (the owner tests with
    # theirs), a subscription link, a draw's seed, a domain's TXT proof
    "identity.user.passwordHash", "identity.user.twoFactorSecret", "identity.session.refreshTokenHash",
    "entitlement.grant.subscriptionTokenHash", "entitlement.grant.subscriptionTokenSealed",
    "engagement.lottery_draw.seedSealed", "tenant.tenant_domain.verificationToken",
    "network.panel.panelApiCredentials", "network.panel.panelRadiusSecret",  # R16's panels
}


@dataclass(frozen=True)
class Sealed:
    """vault.crypto.ts's SealedValue, each part base64."""
    ciphertext: str
    iv: str
    auth_tag: str


@dataclass(frozen=True)
class DevBot:
    """A dev bot of `.env.dev`: what staging's platform bot on its platform becomes."""
    platform: str
    token: str
    username: str
    secret: str


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def seal(plaintext: str, key: bytes) -> Sealed:
    """vault.crypto.ts's seal: a fresh IV every time."""
    iv = os.urandom(IV_BYTES)
    out = AESGCM(key).encrypt(iv, plaintext.encode(), None)
    return Sealed(b64(out[:-TAG_BYTES]), b64(iv), b64(out[-TAG_BYTES:]))


def wrap(dek: bytes, kek: bytes) -> str:
    """A tenant_dek's wrappedKey: the DEK as base64, sealed, as `iv.tag.ciphertext`."""
    sealed = seal(b64(dek), kek)
    return f"{sealed.iv}.{sealed.auth_tag}.{sealed.ciphertext}"


def fingerprint(plaintext: str) -> str:
    digest = hashlib.sha256(FINGERPRINT_DOMAIN + b"\0" + plaintext.encode()).hexdigest()
    return digest[:FINGERPRINT_HEX_CHARS]


def parse_key(raw: str) -> bytes:
    """vault.crypto.ts's parseKey: 32 bytes as hex or base64, nothing else."""
    text = raw.strip()
    if re.fullmatch(r"[0-9a-fA-F]+", text) and len(text) == KEY_BYTES * 2:
        return bytes.fromhex(text)
    key = base64.b64decode(text + "=" * (-len(text) % 4))
    if len(key) != KEY_BYTES:
        raise ValueError(f"the vault KEK is not a {KEY_BYTES}-byte key")
    return key


def dev_bots(env: dict) -> list[DevBot]:
    """One per platform whose token `.env.dev` sets. An unset webhook secret is
    derived from the token, so the guard, in another process, knows it again."""
    bots = []
    for platform in BOT_KINDS:
        prefix = platform.upper()
        token = env.get(f"{prefix}_BOT_TOKEN", "")
        if not token:
            continue
        secret = env.get(f"{prefix}_WEBHOOK_SECRET") or \
            hashlib.sha256(f"txnet:staging:webhook:{token}".encode()).hexdigest()[:32]
        bots.append(DevBot(platform, token, env.get(f"{prefix}_BOT_USERNAME", ""), secret))
    return bots


def dev_env() -> dict:
    """.env then .env.dev, as scripts/seed-bot-integration.sh reads them."""
    files = (ROOT / ".env", ROOT / ".env.dev")
    return {k: v for f in files if f.exists() for k, v in parse_env(f.read_text()).items()}


def q(value: str | None) -> str:
    return "NULL" if value is None else "'" + value.replace("'", "''") + "'"


def bot_sql(bot: DevBot, dek_id: str, dek: bytes) -> list[str]:
    """The platform's primary bot on bot.platform renamed to the dev bot and its
    token and webhook secret written under the integration's label."""
    where = f"WHERE \"tenantId\" = {OWNER} AND role = 'primary' AND platform = {q(bot.platform)}"
    lines = [f"UPDATE automation.bot_integration SET \"botUsername\" = {q(bot.username)}, status = 'active', "
             f"\"lastErrorAt\" = NULL, capabilities = NULL {where};"]
    for kind, value in ((BOT_KINDS[bot.platform], bot.token), (WEBHOOK_KIND, bot.secret)):
        s = seal(value, dek)
        lines.append("INSERT INTO tenant.tenant_credential (id, \"tenantId\", kind, label, ciphertext, iv, "
                     "\"authTag\", \"dekId\", fingerprint, status, version) SELECT gen_random_uuid(), "
                     f"\"tenantId\", {q(kind)}, \"credentialRef\", {q(s.ciphertext)}, {q(s.iv)}, {q(s.auth_tag)}, "
                     f"{q(dek_id)}, {q(fingerprint(value))}, 'active', 1 FROM automation.bot_integration {where};")
    return lines


def keys_sql(bots: list[DevBot], kek: bytes) -> str:
    """One transaction: the vault emptied but for the panels' logins, every bot but
    the dev bots disabled, the dev bots written, the gateways' keys cleared."""
    lines = ["BEGIN;", f"DELETE FROM tenant.tenant_credential WHERE kind <> {q(KEPT_KIND)};"]
    platforms = ", ".join(q(b.platform) for b in bots)
    keep = f" WHERE NOT (\"tenantId\" = {OWNER} AND role = 'primary' AND platform IN ({platforms}))" if bots else ""
    lines.append(f"UPDATE automation.bot_integration SET status = 'disabled'{keep};")
    if bots:
        # A new data key, so nothing of production's is unwrapped: the newest
        # unretired DEK is the one the vault seals under next (activeDek).
        dek, dek_id = AESGCM.generate_key(bit_length=KEY_BYTES * 8), str(uuid.uuid4())
        lines.append(f"INSERT INTO tenant.tenant_dek (id, \"tenantId\", \"wrappedKey\", \"kekId\") "
                     f"SELECT {q(dek_id)}, {OWNER}, {q(wrap(dek, kek))}, {q(KEK_ID)};")
        lines += [line for bot in bots for line in bot_sql(bot, dek_id, dek)]
    lines.append('UPDATE tenant.tenant_gateway_config SET "merchantIdEncrypted" = NULL, "apiKeyEncrypted" = NULL '
                 'WHERE "merchantIdEncrypted" IS NOT NULL OR "apiKeyEncrypted" IS NOT NULL;')
    lines.append(f"UPDATE billing.payment_gateway SET \"merchantId\" = {q(WIPED)} WHERE \"merchantId\" <> {q(WIPED)};")
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


def cluster_kek(kubectl: list[str]) -> bytes:
    """The KEK staging's services mount, read from the cluster into memory only."""
    def get(*args) -> dict:
        return json.loads(subprocess.run([*kubectl, "get", *args, "-o", "json"], check=True, text=True,
                                         capture_output=True).stdout)
    volumes = get("deployment", KEK_DEPLOYMENT)["spec"]["template"]["spec"]["volumes"]
    name = next(v["secret"]["secretName"] for v in volumes if v["name"] == KEK_VOLUME)
    return parse_key(base64.b64decode(get("secret", name)["data"][KEK_ID]).decode())


GUARD_SQL = (
    "SELECT jsonb_build_object("
    f"'owner', {OWNER}, "
    "'vault', (SELECT coalesce(jsonb_agg(jsonb_build_object('tenantId', \"tenantId\", 'kind', kind, "
    f"'fingerprint', fingerprint)), '[]') FROM tenant.tenant_credential WHERE kind <> {q(KEPT_KIND)}), "
    "'bots', (SELECT coalesce(jsonb_agg(jsonb_build_object('tenantId', \"tenantId\", 'platform', platform, "
    "'role', role, 'status', status, 'botUsername', \"botUsername\")), '[]') FROM automation.bot_integration), "
    "'gateway_keys', (SELECT count(*) FROM tenant.tenant_gateway_config WHERE \"merchantIdEncrypted\" IS NOT NULL "
    "OR \"apiKeyEncrypted\" IS NOT NULL), "
    f"'merchant_ids', (SELECT count(*) FROM billing.payment_gateway WHERE \"merchantId\" <> {q(WIPED)}), "
    "'columns', (SELECT coalesce(jsonb_agg(jsonb_build_array(table_schema, table_name, column_name)), '[]') "
    "FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') "
    "AND data_type IN ('text', 'character varying', 'jsonb', 'json', 'ARRAY')));"
)


def findings(state: dict, bots: list[DevBot]) -> list[str]:
    """What of production's keys is still in the copy, one line each."""
    ours = {fingerprint(v) for b in bots for v in (b.token, b.secret)}
    bot_kinds = {*BOT_KINDS.values(), WEBHOOK_KIND}
    real = Counter(row["kind"] for row in state["vault"] if not (
        row["tenantId"] == state["owner"] and row["kind"] in bot_kinds and row["fingerprint"] in ours))
    found = [f"the vault holds {n} {kind} key(s) that are not staging's" for kind, n in sorted(real.items())]
    usernames = {b.platform: b.username for b in bots}
    found += [f"bot @{row['botUsername']} ({row['platform']}, tenant {row['tenantId']}) is {row['status']}: "
              "not the dev bot" for row in state["bots"] if row["status"] != "disabled" and not (
                  row["tenantId"] == state["owner"] and row["role"] == "primary"
                  and row["botUsername"] == usernames.get(row["platform"]))]
    if state["gateway_keys"]:
        found.append(f"tenant_gateway_config: {state['gateway_keys']} gateway(s) still hold a merchant id or key")
    if state["merchant_ids"]:
        found.append(f"payment_gateway: {state['merchant_ids']} merchant id(s) not wiped")
    names = (".".join(c) for c in state["columns"] if KEY_NAME.search(c[2]))
    found += [f"{n}: may hold a key the scrub does not know (add it to KEY_COLUMNS or NOT_KEY)"
              for n in sorted(names) if n not in KEY_COLUMNS | NOT_KEY]
    return found


def scrub(psql, kubectl: list[str]) -> None:
    bots = dev_bots(dev_env())
    psql(keys_sql(bots, cluster_kek(kubectl) if bots else b""))
    named = ", ".join(f"{b.platform} @{b.username}" for b in bots) or "none: every bot disabled"
    print(f"keys: every vault key but the panels' logins deleted, gateways' keys cleared; dev bots {named}")


def guard(psql) -> list[str]:
    return findings(json.loads(psql(GUARD_SQL).strip()), dev_bots(dev_env()))
