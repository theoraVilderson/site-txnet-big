#!/usr/bin/env python3
"""Spec for tools/dns_resolvers.py (NIN-1-l, hosting contract.nodes.md "Domestic DNS").

One file names the resolvers; each test checks one part of turning it into a
host's settings: the file read, the systemd-resolved and Docker settings
written from it, a DNS answer read, and the refusal when no domestic resolver
answers.

    python3 tools/dns_resolvers_test.py
"""
import json
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import dns_resolvers as dr  # noqa: E402

FILE = """
# domestic first, in order
domestic 178.22.122.100
domestic 217.218.127.127   # the state's
fallback 8.8.8.8
fallback 8.8.4.4
check registry.mytxnet.ir
check hot.ir-central1.arvanstorage.ir
"""


def answer(query: bytes, rcode: int = 0, count: int = 1) -> bytes:
    """A response to query: its id and question echoed, `count` A records."""
    header = struct.pack(">HHHHHH", struct.unpack(">H", query[:2])[0], 0x8180 | rcode, 1, count, 0, 0)
    record = b"\xc0\x0c" + struct.pack(">HHIH", 1, 1, 60, 4) + bytes([10, 0, 0, 1])
    return header + query[12:] + record * count


class TheFile(unittest.TestCase):
    def test_order_is_kept_and_comments_are_not_addresses(self):
        plan = dr.parse(FILE)
        self.assertEqual(plan.domestic, ["178.22.122.100", "217.218.127.127"])
        self.assertEqual(plan.fallback, ["8.8.8.8", "8.8.4.4"])
        self.assertEqual(plan.check, ["registry.mytxnet.ir", "hot.ir-central1.arvanstorage.ir"])

    def test_a_line_that_is_not_an_address_is_refused_by_its_number(self):
        with self.assertRaisesRegex(dr.DnsError, "line 2"):
            dr.parse("domestic 1.1.1.1\ndomestic 300.1.1.1\ncheck a.ir")
        with self.assertRaisesRegex(dr.DnsError, "line 1"):
            dr.parse("primary 1.1.1.1\ncheck a.ir")

    def test_no_domestic_resolver_or_no_name_to_check_is_refused(self):
        with self.assertRaisesRegex(dr.DnsError, "domestic"):
            dr.parse("fallback 8.8.8.8\ncheck a.ir")
        with self.assertRaisesRegex(dr.DnsError, "check"):
            dr.parse("domestic 1.1.1.1")

    def test_set_rewrites_the_resolvers_and_keeps_the_names(self):
        text = dr.with_domestic(FILE, ["10.0.0.1", "10.0.0.2"])
        plan = dr.parse(text)
        self.assertEqual(plan.domestic, ["10.0.0.1", "10.0.0.2"])
        self.assertEqual(plan.fallback, ["8.8.8.8", "8.8.4.4"])
        self.assertEqual(plan.check, ["registry.mytxnet.ir", "hot.ir-central1.arvanstorage.ir"])


class Settings(unittest.TestCase):
    def test_resolved_asks_the_domestic_first_and_google_only_as_fallback(self):
        conf = dr.resolved_conf(dr.parse(FILE))
        self.assertIn("[Resolve]\n", conf)
        self.assertIn("\nDNS=178.22.122.100 217.218.127.127\n", conf)
        self.assertIn("\nFallbackDNS=8.8.8.8 8.8.4.4\n", conf)

    def test_docker_gets_the_same_order_and_keeps_its_other_settings(self):
        before = json.dumps({"dns": ["8.8.8.8", "1.1.1.1"], "proxies": {"http-proxy": "http://p:1"}})
        after = json.loads(dr.docker_conf(before, dr.parse(FILE)))
        self.assertEqual(after["dns"], ["178.22.122.100", "217.218.127.127", "8.8.8.8", "8.8.4.4"])
        self.assertEqual(after["proxies"], {"http-proxy": "http://p:1"})
        self.assertEqual(json.loads(dr.docker_conf("", dr.parse(FILE)))["dns"][0], "178.22.122.100")


class DockerRestart(unittest.TestCase):
    # a host running any container is not idle: the dev host keeps the live site and the bot up
    def test_idle_means_no_container_runs(self):
        from unittest import mock
        with mock.patch.object(dr, "run", lambda argv, check=True: mock.Mock(returncode=0, stdout="3f2a\n")):
            self.assertFalse(dr.docker_idle())
        with mock.patch.object(dr, "run", lambda argv, check=True: mock.Mock(returncode=0, stdout="")):
            self.assertTrue(dr.docker_idle())


class Answers(unittest.TestCase):
    def test_a_query_is_one_question_for_an_a_record(self):
        query = dr.query("registry.mytxnet.ir", 7)
        self.assertEqual(struct.unpack(">HHHHHH", query[:12]), (7, 0x0100, 1, 0, 0, 0))
        self.assertTrue(query.endswith(b"\x08registry\x07mytxnet\x02ir\x00\x00\x01\x00\x01"))

    def test_an_address_in_the_answer_is_an_answer(self):
        query = dr.query("a.ir", 9)
        self.assertTrue(dr.answered(query, answer(query)))

    def test_nxdomain_an_empty_answer_or_another_id_is_not(self):
        query = dr.query("a.ir", 9)
        self.assertFalse(dr.answered(query, answer(query, rcode=3, count=0)))
        self.assertFalse(dr.answered(query, answer(query, count=0)))
        self.assertFalse(dr.answered(query, answer(dr.query("a.ir", 10))))


class Refusal(unittest.TestCase):
    def test_nothing_is_applied_when_no_domestic_resolver_answers(self):
        plan = dr.parse(FILE)
        with self.assertRaisesRegex(dr.DnsError, "no domestic resolver"):
            dr.usable(plan, probe=lambda server, name: False)

    def test_a_resolver_answering_only_some_names_is_named_but_not_usable(self):
        plan = dr.parse(FILE)
        good = {("217.218.127.127", n) for n in plan.check}
        self.assertEqual(dr.usable(plan, probe=lambda s, n: (s, n) in good), ["217.218.127.127"])


if __name__ == "__main__":
    unittest.main()
