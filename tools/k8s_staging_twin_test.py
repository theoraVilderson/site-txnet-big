#!/usr/bin/env python3
"""Spec for the twin run (OPS-1-ah-c, ADR-0166 points 4, 5).

    python3 tools/k8s_staging_twin_test.py
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_staging_twin as kt  # noqa: E402


class PanelsTest(unittest.TestCase):
    """Production's panel rows that name its own server's test panels are pointed
    at the local copies: same panels, same credentials, reached with no route out."""

    INSPECT = json.dumps([
        {"NetworkSettings": {"Networks": {"txnet-staging": {"IPAddress": "172.24.0.5"}}},
         "HostConfig": {"PortBindings": {"2053/tcp": [{"HostPort": "28200"}], "2096/tcp": [{"HostPort": "28201"}],
                                         "21001/tcp": [{"HostPort": "21001"}]}}},
        {"NetworkSettings": {"Networks": {"txnet-staging": {"IPAddress": "172.24.0.6"}}},
         "HostConfig": {"PortBindings": {"8080/tcp": [{"HostPort": "28000"}], "24004/udp": [{"HostPort": "24004"}]}}},
    ])

    def test_each_published_tcp_port_maps_to_the_container_on_the_network(self):
        ports = kt.panel_ports(self.INSPECT)
        self.assertEqual(ports["28200"], ("172.24.0.5", "2053"))
        self.assertEqual(ports["28000"], ("172.24.0.6", "8080"))
        self.assertNotIn("24004", ports)

    def test_a_url_on_productions_server_is_pointed_at_its_copy(self):
        ports = kt.panel_ports(self.INSPECT)
        self.assertEqual(kt.repoint("http://2.144.31.149:28200/p2/", "2.144.31.149", ports),
                         "http://172.24.0.5:2053/p2/")

    def test_any_other_panel_is_left_unreachable(self):
        ports = kt.panel_ports(self.INSPECT)
        for url in ("http://193.228.169.47/panel/x/", "http://2.144.31.149:29999/", "https://2.144.31.149:28200/"):
            self.assertIsNone(kt.repoint(url, "2.144.31.149", ports), url)

    def test_the_sql_quotes_what_it_writes(self):
        sql = kt.repoint_sql({"p1": "http://h:1/it's/"})
        self.assertIn("'http://h:1/it''s/'", sql)
        self.assertIn("WHERE id = 'p1'", sql)


class OrderTest(unittest.TestCase):
    # ADR-0166 point 4: the new release lands on the old one holding production's
    # data, so the migration and the roll run as they will there; checks after.
    def test_from_restored_then_to_deployed_then_checked(self):
        steps = []
        stages = kt.Stages(restore=lambda ref: steps.append(("restore", ref)),
                           deploy=lambda ref: steps.append(("deploy", ref)),
                           repoint=lambda: steps.append(("repoint",)),
                           checks={"ready": lambda: steps.append(("ready",)) or True,
                                   "roll": lambda: steps.append(("roll",)) or False,
                                   "panels": lambda: steps.append(("panels",)) or True})
        results = kt.run(stages, "old", "new")
        self.assertEqual(steps[:3], [("restore", "old"), ("deploy", "new"), ("repoint",)])
        # every check runs, so one failure does not hide the next
        self.assertEqual(results, {"ready": True, "roll": False, "panels": True})


class QuietTest(unittest.TestCase):
    # 2026-10-29: the roll began as 35 pods finished booting, at load 9 on 8 cores;
    # billing's old pod missed its liveness probe and 4 of 2658 requests got 502.
    # Production rolls on a settled node, so the twin waits for one.
    def test_waits_until_the_load_falls_under_half_the_cores(self):
        loads = iter([9.0, 6.5, 3.9])
        slept = []
        self.assertTrue(kt.wait_quiet(lambda: next(loads), cores=8, sleep=slept.append, wait_s=600))
        self.assertEqual(len(slept), 2)

    def test_gives_up_after_its_wait_and_says_so(self):
        slept = []
        self.assertFalse(kt.wait_quiet(lambda: 9.0, cores=8, sleep=slept.append, wait_s=30))
        self.assertEqual(sum(slept), 30)


if __name__ == "__main__":
    unittest.main()
