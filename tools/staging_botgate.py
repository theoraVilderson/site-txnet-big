#!/usr/bin/env python3
"""Staging's one way out: the dev bots' gate (hosting R18, ADR-0168 point 5,
OPS-1-ah-j). Standard library only: it runs as is in a python image.

Staging's services call `<gate>/telegram/bot<token>/<method>` (and `/bale/…`)
instead of the bot API: tools/k8s_staging_gate.py aims their env at it. A call is
forwarded to the dev host's own API base only when its token is a dev bot's (the
gate holds sha256 hashes, never a token) and its method sends or reads. Anything
that would move the bot — setWebhook, setMyCommands, getUpdates — is answered
here with 403 and goes nowhere: the dev bot's webhook stays dev's.

    GATE_UPSTREAM_TELEGRAM, GATE_UPSTREAM_BALE   where each platform's calls go
    GATE_TOKENS_TELEGRAM, GATE_TOKENS_BALE       comma-separated sha256 of the dev tokens
"""
import hashlib
import http.server
import json
import os
import re
import urllib.error
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


class Gate(http.server.BaseHTTPRequestHandler):
    upstreams: dict[str, str] = {}
    hashes: dict[str, set[str]] = {}

    def do_GET(self):
        self.relay()

    def do_POST(self):
        self.relay()

    def relay(self):
        platform, _, rest = self.path.lstrip("/").partition("/")
        if not decide(platform, "/" + rest, self.hashes):
            # The method only: the path holds a token.
            self.log_message("refused %s %s", platform, rest.rsplit("/", 1)[-1])
            self.answer(403, {"ok": False, "error_code": 403, "description": "refused by staging's gate"})
            return
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)) if self.command == "POST" else None
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


def server(address, upstreams: dict[str, str], hashes: dict[str, set[str]]) -> http.server.ThreadingHTTPServer:
    handler = type("ConfiguredGate", (Gate,), {"upstreams": {p: u.rstrip("/") for p, u in upstreams.items()},
                                               "hashes": hashes})
    return http.server.ThreadingHTTPServer(address, handler)


def main() -> None:
    upstreams = {p: os.environ[f"GATE_UPSTREAM_{p.upper()}"] for p in PLATFORMS}
    hashes = {p: {h for h in os.environ.get(f"GATE_TOKENS_{p.upper()}", "").split(",") if h} for p in PLATFORMS}
    server(("0.0.0.0", PORT), upstreams, hashes).serve_forever()


if __name__ == "__main__":
    main()
