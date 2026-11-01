#!/usr/bin/env python3
"""Staging's one way out: the dev bots' gate (hosting R18, ADR-0168 point 5,
OPS-1-ah-j). Standard library only: it runs as is in a python image.

Staging's services call `<gate>/telegram/bot<token>/<method>` (and `/bale/…`)
instead of the bot API: tools/k8s_staging_gate.py aims their env at it. A call is
forwarded to the dev host's own API base only when its token is a dev bot's (the
gate holds sha256 hashes, never a token) and its method sends or reads. Anything
that would move the bot — setWebhook, setMyCommands, getUpdates — is answered
here with 403 and goes nowhere: the dev bot's webhook stays dev's. A call that
names a chat goes out only to one of the owner's own (OPS-1-ah-p), and a send
must name one: a real chat id the scrub missed is still never written to.

    GATE_UPSTREAM_TELEGRAM, GATE_UPSTREAM_BALE   where each platform's calls go
    GATE_TOKENS_TELEGRAM, GATE_TOKENS_BALE       comma-separated sha256 of the dev tokens
    GATE_OWNERS_TELEGRAM, GATE_OWNERS_BALE       comma-separated chat ids of the owner's
"""
import email.parser
import email.policy
import hashlib
import http.server
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

PLATFORMS = ("telegram", "bale")
PORT = 8080
UPSTREAM_TIMEOUT_S = 60
# The bot API's own path shapes: `/bot<token>/<method>` and `/file/bot<token>/<path>`.
CALL = re.compile(r"^/(file/)?bot([0-9]+:[A-Za-z0-9_-]+)/(.+)$")
# Sends, edits, answers and reads: what a notice, a menu, a payment or a file
# needs. Nothing that registers, unregisters or polls the bot.
ALLOWED_METHOD = re.compile(r"^((send|edit|answer|copy|forward)[A-Z]\w*|deleteMessages?|createInvoiceLink"
                            r"|getMe|getFile|getChat|getChatMember|getWebhookInfo)$")
# Methods that deliver to a chat: each must name one of the owner's.
DELIVERS = re.compile(r"^(send|copy|forward)[A-Z]\w*$")
# Reads write to no one: a channel-membership check names the channel, not a person.
READS = re.compile(r"^get[A-Z]\w*$")
# Headers the upstream sets for itself, or that describe this hop only.
HOP_HEADERS = {"host", "connection", "content-length", "transfer-encoding", "keep-alive", "accept-encoding"}


def decide(platform: str, path: str, hashes: dict[str, set[str]]) -> bool:
    """Whether a call on `platform` at `path` (after the platform prefix) goes out."""
    match = CALL.match(path)
    if platform not in PLATFORMS or not match or ".." in path:
        return False
    is_file, token, rest = match.groups()
    if hashlib.sha256(token.encode()).hexdigest() not in hashes.get(platform, set()):
        return False
    return bool(is_file) or bool(ALLOWED_METHOD.match(rest.split("?")[0]))


def chat_of(query: str, content_type: str, body: bytes) -> str | None:
    """The call's chat_id, wherever the bot API lets a client put it."""
    found = urllib.parse.parse_qs(query).get("chat_id")
    kind = content_type.split(";")[0].strip().lower()
    if not found and kind == "application/json":
        try:
            value = json.loads(body or b"{}").get("chat_id")
        except (ValueError, AttributeError):
            return None
        found = None if value is None else [str(value)]
    elif not found and kind == "application/x-www-form-urlencoded":
        found = urllib.parse.parse_qs(body.decode(errors="replace")).get("chat_id")
    elif not found and kind == "multipart/form-data":
        message = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
            f"Content-Type: {content_type}\r\n\r\n".encode() + body)
        found = [part.get_content().strip() for part in message.iter_parts()
                 if part.get_param("name", header="content-disposition") == "chat_id"]
    return found[0] if found else None


def to_owner(method: str, chat: str | None, owners: set[str]) -> bool:
    """A call writing to a chat goes out only to one of the owner's; a send must name one."""
    if READS.match(method):
        return True
    return chat in owners if chat is not None else not DELIVERS.match(method)


class Gate(http.server.BaseHTTPRequestHandler):
    upstreams: dict[str, str] = {}
    hashes: dict[str, set[str]] = {}
    owners: dict[str, set[str]] = {}

    def do_GET(self):
        self.relay()

    def do_POST(self):
        self.relay()

    def relay(self):
        platform, _, rest = self.path.lstrip("/").partition("/")
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)) if self.command == "POST" else None
        if not decide(platform, "/" + rest, self.hashes) or not self.reaches_owner(platform, rest, body or b""):
            # The method only: the path holds a token.
            self.log_message("refused %s %s", platform, rest.rsplit("/", 1)[-1].split("?")[0])
            self.answer(403, {"ok": False, "error_code": 403, "description": "refused by staging's gate"})
            return
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_HEADERS}
        request = urllib.request.Request(f"{self.upstreams[platform]}/{rest}", data=body, headers=headers,
                                         method=self.command)
        try:
            with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_S) as response:
                self.copy(response.status, response.headers, response.read())
        except urllib.error.HTTPError as e:
            self.copy(e.code, e.headers, e.read())
        except OSError as e:
            self.answer(502, {"ok": False, "error_code": 502, "description": f"gate: {e.__class__.__name__}"})

    def reaches_owner(self, platform: str, rest: str, body: bytes) -> bool:
        is_file, _, call = CALL.match("/" + rest).groups()
        method, _, query = call.partition("?")
        return bool(is_file) or to_owner(method, chat_of(query, self.headers.get("Content-Type", ""), body),
                                         self.owners.get(platform, set()))

    def copy(self, status: int, headers, body: bytes):
        self.send_response(status)
        for key, value in headers.items():
            if key.lower() not in HOP_HEADERS:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def answer(self, status: int, payload: dict):
        self.copy(status, {"Content-Type": "application/json"}, json.dumps(payload).encode())

    def log_message(self, fmt, *args):
        # Never the request line: it carries the token.
        if fmt.startswith("refused"):
            super().log_message(fmt, *args)


def server(address, upstreams: dict[str, str], hashes: dict[str, set[str]],
           owners: dict[str, set[str]] | None = None) -> http.server.ThreadingHTTPServer:
    handler = type("ConfiguredGate", (Gate,), {"upstreams": {p: u.rstrip("/") for p, u in upstreams.items()},
                                               "hashes": hashes, "owners": owners or {}})
    return http.server.ThreadingHTTPServer(address, handler)


def main() -> None:
    upstreams = {p: os.environ[f"GATE_UPSTREAM_{p.upper()}"] for p in PLATFORMS}
    def listed(var: str) -> dict[str, set[str]]:
        return {p: {v for v in os.environ.get(f"{var}_{p.upper()}", "").split(",") if v} for p in PLATFORMS}
    server(("0.0.0.0", PORT), upstreams, listed("GATE_TOKENS"), listed("GATE_OWNERS")).serve_forever()


if __name__ == "__main__":
    main()
