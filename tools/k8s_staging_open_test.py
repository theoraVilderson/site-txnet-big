#!/usr/bin/env python3
"""Spec for `staging.sh open` (OPS-1-ah-i, ADR-0168 point 3).

    python3 tools/k8s_staging_open_test.py
"""
import socket
import ssl
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_staging_open as ko  # noqa: E402

HOST = "panel.example.test"


def tls_server(ca: ko.Ca, work: Path, seen: dict) -> socket.socket:
    """Traefik's stand-in: TLS on a free port, asking for a client certificate
    signed by `ca` (O3), answering one request with what it saw."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(*ca.issue(HOST, work))
    ctx.verify_mode = ssl.CERT_REQUIRED
    ctx.load_verify_locations(cadata=ca.cert_pem.decode())
    ctx.sni_callback = lambda s, name, c: seen.__setitem__("sni", name)
    listener = socket.create_server(("127.0.0.1", 0))

    def serve():
        conn, _ = listener.accept()
        with ctx.wrap_socket(conn, server_side=True) as tls:
            seen["client"] = tls.getpeercert()["subject"]
            request = tls.recv(4096).decode()
            seen["host"] = next(line for line in request.splitlines() if line.lower().startswith("host:"))
            tls.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
    threading.Thread(target=serve, daemon=True).start()
    return listener


class CaTest(unittest.TestCase):
    """The owner trusts staging's CA once; it is made once and kept."""

    def test_the_ca_is_made_once_with_an_owner_only_key(self):
        with tempfile.TemporaryDirectory() as d:
            first = ko.Ca.load_or_make(Path(d))
            self.assertEqual(ko.Ca.load_or_make(Path(d)).cert_pem, first.cert_pem)
            self.assertEqual((Path(d) / ko.CA_KEY).stat().st_mode & 0o777, 0o600)

    def test_a_host_certificate_names_the_host_and_is_signed_by_the_ca(self):
        with tempfile.TemporaryDirectory() as d:
            ca = ko.Ca.load_or_make(Path(d) / "ca")
            ctx = ssl.create_default_context(cadata=ca.cert_pem.decode())
            server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server.load_cert_chain(*ca.issue(HOST, Path(d)))
            a, b = socket.socketpair()
            t = threading.Thread(target=lambda: server.wrap_socket(a, server_side=True).close(), daemon=True)
            t.start()
            ctx.wrap_socket(b, server_hostname=HOST).close()  # raises unless verified for HOST
            t.join()


class RequestTest(unittest.TestCase):
    """Only CONNECT to 443 is tunnelled; plain http is sent to https."""

    def test_connect_names_the_host(self):
        self.assertEqual(ko.connect_target("CONNECT panel.example.test:443 HTTP/1.1"), HOST)

    def test_another_port_or_method_is_not_tunnelled(self):
        self.assertIsNone(ko.connect_target("CONNECT panel.example.test:22 HTTP/1.1"))
        self.assertIsNone(ko.connect_target("GET http://panel.example.test/ HTTP/1.1"))

    def test_plain_http_is_redirected_to_https(self):
        self.assertEqual(ko.https_location("GET http://panel.example.test/a?b=1 HTTP/1.1"),
                         "https://panel.example.test/a?b=1")
        self.assertIsNone(ko.https_location("GET / HTTP/1.1"))


class ProxyTest(unittest.TestCase):
    """The browser's tunnel reaches staging's Traefik by the host's own SNI,
    presenting the origin-pull pair, and nothing else."""

    def test_a_request_through_the_tunnel_presents_the_pull_pair(self):
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            ca = ko.Ca.load_or_make(work / "ca")
            pull = ko.Ca.load_or_make(work / "pull")  # O1's CA, and a client pair it signed
            seen = {}
            traefik = tls_server(pull, work, seen)
            proxy = ko.Proxy(("127.0.0.1", 0), ca, work, upstream=traefik.getsockname()[1],
                             pull_pair=pull.issue("origin-pull client", work))
            threading.Thread(target=proxy.serve_forever, daemon=True).start()
            try:
                browser = socket.create_connection(proxy.server_address)
                browser.sendall(f"CONNECT {HOST}:443 HTTP/1.1\r\nHost: {HOST}:443\r\n\r\n".encode())
                self.assertIn(b" 200 ", browser.recv(4096))
                tls = ssl.create_default_context(cadata=ca.cert_pem.decode()).wrap_socket(
                    browser, server_hostname=HOST)
                tls.sendall(f"GET / HTTP/1.1\r\nHost: {HOST}\r\n\r\n".encode())
                answer = b""
                while chunk := tls.recv(4096):
                    answer += chunk
                tls.close()
            finally:
                proxy.shutdown()
                proxy.server_close()
                traefik.close()
            self.assertTrue(answer.endswith(b"ok"))
            self.assertEqual(seen["sni"], HOST)
            self.assertEqual(seen["host"], f"Host: {HOST}")
            self.assertIn((("commonName", "origin-pull client"),), seen["client"])

    def test_a_request_that_is_not_connect_is_refused_without_dialing(self):
        with tempfile.TemporaryDirectory() as d:
            work = Path(d)
            proxy = ko.Proxy(("127.0.0.1", 0), ko.Ca.load_or_make(work / "ca"), work, upstream=1,
                             pull_pair=(work / "none.pem", work / "none.key"))
            threading.Thread(target=proxy.serve_forever, daemon=True).start()
            try:
                browser = socket.create_connection(proxy.server_address)
                browser.sendall(b"GET http://example.com/x HTTP/1.1\r\nHost: example.com\r\n\r\n")
                answer = browser.recv(4096).decode()
                browser.close()
            finally:
                proxy.shutdown()
                proxy.server_close()
            self.assertIn(" 301 ", answer)
            self.assertIn("Location: https://example.com/x", answer)


class InstructionsTest(unittest.TestCase):
    def test_the_owner_is_told_the_tunnel_the_ca_and_the_hosts(self):
        text = ko.instructions(8443, ["b.example", "a.example"], Path("/var/lib/txnet/staging-ca"))
        self.assertIn("ssh -N -L 8443:127.0.0.1:8443", text)
        self.assertIn("/var/lib/txnet/staging-ca/ca.crt", text)
        self.assertLess(text.index("https://a.example"), text.index("https://b.example"))


if __name__ == "__main__":
    unittest.main()
