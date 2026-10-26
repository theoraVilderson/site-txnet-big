"""NIN-1-d1: the domestic domain's records, as code, on ArvanCloud.

Run: python3 -m unittest scripts/edge/test_arvan_zone.py
"""
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import arvan_zone as az  # noqa: E402

IP = "203.0.113.10"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def door(rid, name, ip=IP, cloud=True, upstream="https", port=az.DOOR_PORT):
    return {"id": rid, "type": "a", "name": name, "value": [{"ip": ip, "port": port, "weight": 100}],
            "cloud": cloud, "upstream_https": upstream}


def want(name, ip=IP):
    return {"type": "a", "name": name, "value": [{"ip": ip, "port": az.DOOR_PORT}], "cloud": True,
            "upstream_https": "https", "ttl": az.TTL}


def target(rid="50", ip=IP, cloud=False):
    return {"id": rid, "type": "a", "name": az.TARGET_NAME, "value": [{"ip": ip}], "cloud": cloud, "upstream_https": "default"}


TARGET = {"type": "a", "name": az.TARGET_NAME, "value": [{"ip": IP}], "cloud": False, "ttl": az.TTL}
READY = [door(str(i), name) for i, name in enumerate(az.DOOR_NAMES)] + [target()]
SSL_ON = {"ssl_status": True}


class Plan(unittest.TestCase):
    def test_an_empty_zone_gets_each_door_on_the_domestic_port(self):
        ops = az.plan([], IP, SSL_ON)
        self.assertEqual(ops.changes, [("create", None, want(name)) for name in az.DOOR_NAMES] + [("create", None, TARGET)])

    def test_a_ready_zone_changes_nothing(self):
        ops = az.plan(READY, IP, SSL_ON)
        self.assertEqual((ops.changes, ops.leaks), ([], []))
        self.assertEqual(az.plan(READY, None, SSL_ON).changes, [])  # no address needed once they exist

    def test_a_door_with_the_cloud_off_or_plain_http_upstream_is_corrected(self):
        for wrong in (door("0", "api", cloud=False), door("0", "api", upstream="http")):
            ops = az.plan([wrong] + READY[1:], IP, SSL_ON)
            self.assertEqual(ops.changes, [("update", "0", want("api"))])

    def test_a_new_address_moves_the_doors_only_when_given(self):
        ops = az.plan(READY, "203.0.113.99", SSL_ON)
        moved = dict(TARGET, value=[{"ip": "203.0.113.99"}])
        self.assertEqual(ops.changes, [("update", str(i), want(name, "203.0.113.99"))
                                       for i, name in enumerate(az.DOOR_NAMES)] + [("update", "50", moved)])

    def test_a_missing_door_with_no_address_is_refused(self):
        with self.assertRaises(az.ZoneError):
            az.plan(READY[1:], None, SSL_ON)

    # NIN-1-e1, ADR-0165 point 7: a reseller's own edge points at
    # `<slug>.edge.<domestic>`, DNS-only, so its requests never chain through
    # our Arvan. It publishes the address on purpose: never a leak warning.
    def test_the_resellers_target_is_dns_only_and_is_not_a_leak(self):
        self.assertEqual(az.plan(READY, IP, SSL_ON).leaks, [])
        ops = az.plan(READY[:-1] + [target(cloud=True)], IP, SSL_ON)
        self.assertEqual(ops.changes, [("update", "50", TARGET)])

    def test_a_record_it_did_not_make_on_a_door_name_is_refused_never_overwritten(self):
        # barghgho.ir's `panel` was a reseller's CNAME to our Cloudflare edge.
        reseller = {"id": "9", "type": "cname", "name": "panel", "value": {"host": "txnet.edge.txnet.cyou."},
                    "cloud": True, "upstream_https": "default"}
        other_port = door("8", "sub", port=8780)
        for theirs in (reseller, other_port):
            with self.assertRaises(az.ZoneError, msg=theirs["name"]):
                az.plan([r for r in READY if r["name"] != theirs["name"]] + [theirs], IP, SSL_ON)

    def test_records_on_other_names_are_never_touched(self):
        bots = [door("20", "tel-bot", ip="198.51.100.5", upstream="http", port=8780),
                {"id": "21", "type": "txt", "name": "_domain-verification.shop", "value": {"text": "x"}}]
        self.assertEqual(az.plan(READY + bots, IP, SSL_ON).changes, [])

    def test_the_edge_certificate_is_turned_on_when_it_is_off(self):
        ops = az.plan(READY, IP, {"ssl_status": False})
        self.assertEqual(ops.changes, [("ssl", None, {"ssl_status": True})])

    def test_a_record_naming_the_origin_with_the_cloud_off_is_reported_never_changed(self):
        apex = door("30", "@", cloud=False, upstream="default", port=None)
        ops = az.plan(READY + [apex], IP, SSL_ON)
        self.assertEqual((ops.changes, ops.leaks), ([], ["@"]))

    def test_two_records_for_one_door_are_refused_not_guessed(self):
        with self.assertRaises(az.ZoneError):
            az.plan(READY + [door("40", "api")], IP, SSL_ON)


class Repoint(unittest.TestCase):
    def test_only_its_own_doors_on_the_old_address_move(self):
        bot = door("20", "tel-bot", upstream="http", port=8780)  # same address, not ours
        ops = az.repoint(READY + [bot], IP, "203.0.113.99")
        self.assertEqual([(rid, body["name"], body["value"][0]["ip"]) for _, rid, body in ops],
                         [(str(i), name, "203.0.113.99") for i, name in enumerate(az.DOOR_NAMES)]
                         + [("50", az.TARGET_NAME, "203.0.113.99")])

    def test_an_old_address_none_of_its_doors_holds_or_a_bad_address_is_refused(self):
        for old, new in (("198.51.100.200", "203.0.113.99"), (IP, IP), (IP, "nope"), (IP, "2001:db8::1")):
            with self.assertRaises(az.ZoneError, msg=(old, new)):
                az.repoint(READY, old, new)


class Doors(unittest.TestCase):
    def test_the_names_are_the_doors_the_seed_makes(self):
        # One list in two languages: the seed makes the rows the tenant
        # resolver matches, this makes the records reaching them.
        with open(os.path.join(ROOT, "txnet-backend/prisma/seed-platform-doors.js"), encoding="utf-8") as f:
            seeded = re.findall(r"\{ prefix: '(\w+)'", f.read())
        self.assertEqual(sorted(seeded), sorted(az.DOOR_NAMES))


if __name__ == "__main__":
    unittest.main()
