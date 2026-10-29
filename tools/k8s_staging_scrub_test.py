#!/usr/bin/env python3
"""Spec for staging's scrubbed copy of production (OPS-1-ah-f, ADR-0168 points 1, 2).

    python3 tools/k8s_staging_scrub_test.py
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_staging_scrub as sc  # noqa: E402

PROD = "2.144.31.149"
INSPECT = json.dumps([
    {"NetworkSettings": {"Networks": {"txnet-staging": {"IPAddress": "203.0.113.5"}}},
     "HostConfig": {"PortBindings": {"2053/tcp": [{"HostPort": "28200"}], "2096/tcp": [{"HostPort": "28201"}],
                                     "21001/tcp": [{"HostPort": "21001"}]}}},
    {"NetworkSettings": {"Networks": {"txnet-staging": {"IPAddress": "203.0.113.6"}}},
     "HostConfig": {"PortBindings": {"8080/tcp": [{"HostPort": "28000"}], "24004/udp": [{"HostPort": "24004"}]}}},
])
LOCAL = sc.Local.from_inspect(INSPECT)


def panel(pid, url, **more):
    return {"id": pid, "name": pid, "apiBaseUrl": url, "clientBaseUrl": None, "ipAddress": None,
            "knownAddresses": [], "ovpnProfile": None, "panelApiCredentials": f"vault:t:panel_credentials:panel:{pid}",
            "panelRadiusSecret": None, "retiredAt": None, **more}


class LocalPanelsTest(unittest.TestCase):
    def test_each_published_tcp_port_maps_to_the_container_on_the_network(self):
        self.assertEqual(LOCAL.ports["28200"], ("203.0.113.5", "2053"))
        self.assertEqual(LOCAL.ports["28000"], ("203.0.113.6", "8080"))
        self.assertNotIn("24004", LOCAL.ports)
        self.assertEqual(LOCAL.addresses, {"203.0.113.5", "203.0.113.6"})

    def test_a_url_on_productions_server_is_pointed_at_its_copy(self):
        self.assertEqual(sc.repoint("http://2.144.31.149:28200/p2/", PROD, LOCAL), "http://203.0.113.5:2053/p2/")

    def test_any_other_url_has_no_copy(self):
        for url in ("http://193.228.169.47/panel/x/", "http://2.144.31.149:29999/", "https://2.144.31.149:28200/", None):
            self.assertIsNone(sc.repoint(url, PROD, LOCAL), url)


class PlanTest(unittest.TestCase):
    """Each panel is pointed at a local test panel of its family, or wiped."""

    def test_a_test_panel_is_pointed_and_a_resellers_is_wiped(self):
        rows = [panel("test", "http://2.144.31.149:28200/p2/", ipAddress=PROD, knownAddresses=[PROD]),
                panel("real", "http://193.228.169.47/panel/x/")]
        pointed, wiped = sc.plan(rows, PROD, LOCAL)
        self.assertEqual(pointed, {"test": {"apiBaseUrl": "http://203.0.113.5:2053/p2/", "clientBaseUrl": None,
                                            "ipAddress": "203.0.113.5"}})
        self.assertEqual(wiped, ["real"])

    def test_a_retired_panel_is_wiped_even_on_the_test_server(self):
        _, wiped = sc.plan([panel("old", "http://2.144.31.149:28200/", retiredAt="2026-10-01")], PROD, LOCAL)
        self.assertEqual(wiped, ["old"])

    def test_no_local_panel_running_wipes_them_all(self):
        pointed, wiped = sc.plan([panel("test", "http://2.144.31.149:28200/")], PROD, sc.Local({}))
        self.assertEqual((pointed, wiped), ({}, ["test"]))

    def test_the_sql_quotes_what_it_writes_and_keeps_only_the_pointed_logins(self):
        sql = sc.panels_sql({"p1": {"apiBaseUrl": "http://h:1/it's/", "clientBaseUrl": None, "ipAddress": None}})
        self.assertIn("'http://h:1/it''s/'", sql)
        self.assertIn("WHERE id = 'p1'", sql)
        # every other panel: no address, no login, collection stopped
        self.assertIn('"panelApiCredentials" = \'\'', sql)
        self.assertIn('"retiredAt" = coalesce("retiredAt", now())', sql)
        self.assertIn("'panel:p1', 'panel:p1:radius'", sql)
        self.assertIn("source_panel_credentials", sql)

    def test_each_wiped_panel_gets_an_address_of_its_own(self):
        # panel_api_address_key: one panel per API address (found by the dev dry run)
        self.assertIn(f"ELSE '{sc.WIPED_URL}' || id END", sc.panels_sql({}))


class GuardTest(unittest.TestCase):
    """Staging does not start while one panel row names a real address."""

    def test_a_scrubbed_copy_passes(self):
        rows = [panel("test", "http://203.0.113.5:2053/p2/", ipAddress="203.0.113.5"),
                panel("real", sc.WIPED_URL, ipAddress=sc.WIPED_ADDRESS, panelApiCredentials="", retiredAt="now"),
                panel("push", None, ipAddress=sc.WIPED_ADDRESS, panelApiCredentials="", retiredAt="now")]
        self.assertEqual(sc.offenders(rows, LOCAL, vault_labels=["panel:test"]), [])

    def test_every_field_that_names_an_address_is_read(self):
        cases = {"apiBaseUrl": {"apiBaseUrl": "http://193.228.169.47/"},
                 "clientBaseUrl": {"clientBaseUrl": "https://sub.reseller.example/"},
                 "ipAddress": {"ipAddress": "193.228.169.47"},
                 "knownAddresses": {"knownAddresses": ["203.0.113.5", "193.228.169.47"]},
                 "ovpnProfile": {"ovpnProfile": "remote vpn.reseller.example 1194"}}
        for field, change in cases.items():
            rows = [{**panel("p", "http://203.0.113.5:2053/"), **change}]
            found = sc.offenders(rows, LOCAL, vault_labels=[])
            self.assertEqual(len(found), 1, field)
            self.assertIn(field, found[0])

    def test_a_wiped_panel_still_holding_a_login_is_refused(self):
        rows = [panel("real", sc.WIPED_URL, retiredAt="now")]
        self.assertIn("login", sc.offenders(rows, LOCAL, vault_labels=[])[0])
        rows[0]["panelApiCredentials"] = ""
        self.assertIn("vault", sc.offenders(rows, LOCAL, vault_labels=["panel:real:radius"])[0])

    def test_a_login_of_a_deleted_panel_is_refused(self):
        # the dev dry run found one: its panel row gone, its login still in the vault
        found = sc.offenders([panel("test", "http://203.0.113.5:2053/")], LOCAL,
                             vault_labels=["panel:test", "panel:gone"])
        self.assertEqual(len(found), 1)
        self.assertIn("panel:gone", found[0])

    def test_a_local_panel_left_in_service_is_the_only_live_one(self):
        rows = [panel("p", sc.WIPED_URL, panelApiCredentials="")]
        self.assertIn("in service", sc.offenders(rows, LOCAL, vault_labels=[])[0])

    def test_a_source_panels_login_is_refused(self):
        self.assertIn("source panel", sc.offenders([], LOCAL, vault_labels=[], source_logins=1)[0])


if __name__ == "__main__":
    unittest.main()
