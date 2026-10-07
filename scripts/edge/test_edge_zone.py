"""EDGE-1-i: the platform zone holds what a reseller's domain needs at go-live.

Run: python3 -m unittest scripts/edge/test_edge_zone.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import edge_zone as ez  # noqa: E402

DOMAIN = "example.test"
FALLBACK = "edge-origin.example.test"
IP = "203.0.113.10"


def rec(rid, type_, name, content, proxied=True):
    return {"id": rid, "type": type_, "name": name, "content": content, "proxied": proxied}


READY = [
    rec("1", "A", FALLBACK, IP),
    rec("2", "CNAME", "*.edge." + DOMAIN, FALLBACK),
    rec("3", "A", "panel." + DOMAIN, IP),
]


class Plan(unittest.TestCase):
    def test_an_empty_zone_gets_the_origin_the_wildcard_and_the_fallback(self):
        ops = ez.plan([], DOMAIN, FALLBACK, IP, None)
        self.assertEqual(ops.changes, [
            ("create", None, {"type": "A", "name": FALLBACK, "content": IP, "proxied": True}),
            ("create", None, {"type": "CNAME", "name": "*.edge." + DOMAIN, "content": FALLBACK, "proxied": True}),
            ("fallback", None, {"origin": FALLBACK}),
        ])

    def test_a_ready_zone_changes_nothing(self):
        ops = ez.plan(READY, DOMAIN, FALLBACK, IP, FALLBACK)
        self.assertEqual(ops.changes, [])
        self.assertEqual(ops.leaks, [])

    def test_a_wildcard_left_unproxied_or_aimed_elsewhere_is_corrected(self):
        for wrong in (rec("2", "CNAME", "*.edge." + DOMAIN, FALLBACK, proxied=False),
                      rec("2", "CNAME", "*.edge." + DOMAIN, "old.arvan.example")):
            ops = ez.plan([READY[0], wrong], DOMAIN, FALLBACK, IP, FALLBACK)
            self.assertEqual(ops.changes, [
                ("update", "2", {"type": "CNAME", "name": "*.edge." + DOMAIN, "content": FALLBACK, "proxied": True}),
            ])

    def test_without_an_address_the_origin_record_is_kept_as_it_is(self):
        ops = ez.plan(READY, DOMAIN, FALLBACK, None, FALLBACK)
        self.assertEqual(ops.changes, [])
        with self.assertRaises(ez.ZoneError):
            ez.plan([], DOMAIN, FALLBACK, None, None)  # nothing to point it at

    def test_an_unproxied_record_naming_the_origin_is_reported_never_changed(self):
        # mail.<domain> has to be DNS-only, and it shows the address to anyone.
        mail = rec("9", "A", "mail." + DOMAIN, IP, proxied=False)
        ops = ez.plan(READY + [mail], DOMAIN, FALLBACK, IP, FALLBACK)
        self.assertEqual(ops.changes, [])
        self.assertEqual(ops.leaks, ["mail." + DOMAIN])

    def test_a_fallback_outside_the_zone_or_under_the_wildcard_is_refused(self):
        for bad in ("edge-origin.other.example", "x.edge." + DOMAIN, DOMAIN):
            with self.assertRaises(ez.ZoneError, msg=bad):
                ez.plan([], DOMAIN, bad, IP, None)

    def test_two_records_for_one_name_are_refused_not_guessed(self):
        twin = rec("4", "A", FALLBACK, "198.51.100.1")
        with self.assertRaises(ez.ZoneError):
            ez.plan(READY + [twin], DOMAIN, FALLBACK, IP, FALLBACK)


class Repoint(unittest.TestCase):
    def test_every_record_on_the_old_address_moves_and_nothing_else(self):
        other = rec("5", "A", "status." + DOMAIN, "198.51.100.7")
        mail = rec("9", "A", "mail." + DOMAIN, IP, proxied=False)
        ops = ez.repoint(READY + [other, mail], IP, "203.0.113.99")
        self.assertEqual([(op, rid, body["name"], body["content"]) for op, rid, body in ops], [
            ("update", "1", FALLBACK, "203.0.113.99"),
            ("update", "3", "panel." + DOMAIN, "203.0.113.99"),
            ("update", "9", "mail." + DOMAIN, "203.0.113.99"),
        ])
        self.assertFalse(ops[2][2]["proxied"])  # proxy state is kept as it was

    def test_an_old_address_no_record_holds_is_refused(self):
        with self.assertRaises(ez.ZoneError):
            ez.repoint(READY, "198.51.100.200", "203.0.113.99")

    def test_a_malformed_or_equal_address_is_refused(self):
        for old, new in ((IP, "not-an-ip"), ("x", IP), (IP, IP), (IP, "2001:db8::1")):
            with self.assertRaises(ez.ZoneError, msg=(old, new)):
                ez.repoint(READY, old, new)


if __name__ == "__main__":
    unittest.main()
