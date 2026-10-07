"""EDGE-1-h: the swarm host admits 80/443 from Cloudflare's ranges only.

Run: python3 -m unittest scripts/edge/test_cloudflare_firewall.py
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import cloudflare_firewall as fw  # noqa: E402

V4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
      "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
      "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
      "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"]
V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
      "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"]


def answer(v4=V4, v6=V6, success=True):
    return json.dumps({"success": success, "result": {"ipv4_cidrs": v4, "ipv6_cidrs": v6}})


class Ranges(unittest.TestCase):
    def test_cloudflares_answer_is_read_per_family(self):
        r = fw.parse_ranges(answer())
        self.assertEqual(r[4], V4)
        self.assertEqual(r[6], V6)

    def test_a_short_malformed_or_failed_list_is_refused_never_applied(self):
        # An empty chain would drop every visitor: the old rules must stay.
        for bad in (answer(v4=[]), answer(v4=V4[:3]), answer(v6=["2400:cb00::/32", "nope"]),
                    answer(v4=V4 + ["0.0.0.0/0"]), answer(success=False), "<html>", ""):
            with self.assertRaises(fw.RangeError, msg=bad[:60]):
                fw.parse_ranges(bad)

    def test_a_range_in_the_wrong_family_is_refused(self):
        with self.assertRaises(fw.RangeError):
            fw.parse_ranges(answer(v4=V4 + ["2400:cb00::/32"]))


class Rules(unittest.TestCase):
    def setUp(self):
        self.text = fw.restore_payload(V4, "ens192")
        self.lines = self.text.splitlines()

    def test_the_chain_admits_each_range_then_drops(self):
        admits = [l for l in self.lines if l.startswith(f"-A {fw.CHAIN} -s ")]
        self.assertEqual(len(admits), len(V4))
        self.assertTrue(all(l.endswith("-j RETURN") for l in admits))
        last = [l for l in self.lines if l.startswith(f"-A {fw.CHAIN}")][-1]
        self.assertEqual(last, f"-A {fw.CHAIN} -j DROP")

    def test_it_is_one_atomic_table_write_that_redeclares_the_chain(self):
        self.assertEqual(self.lines[0], "*filter")
        self.assertIn(f":{fw.CHAIN} - [0:0]", self.lines)
        self.assertEqual(self.lines[-1], "COMMIT")

    def test_only_web_ports_on_the_public_interface_are_sent_to_it(self):
        jumps = fw.jump_rules("ens192")
        # The host's own sockets (Traefik in host mode) and published ports
        # (DNATed, so matched on the original destination port).
        self.assertIn(("INPUT", ["-i", "ens192", "-p", "tcp", "-m", "multiport", "--dports", "80,443", "-j", fw.CHAIN]), jumps)
        for port in ("80", "443"):
            self.assertIn(("DOCKER-USER", ["-i", "ens192", "-p", "tcp", "-m", "conntrack", "--ctorigdstport", port,
                                           "--ctdir", "ORIGINAL", "-j", fw.CHAIN]), jumps)
        self.assertTrue(all("-i" in args for _, args in jumps), "an internal bridge must never be filtered")


if __name__ == "__main__":
    unittest.main()
