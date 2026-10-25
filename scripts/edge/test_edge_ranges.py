"""NIN-1-b1: the approved-edge list, each edge's ranges re-read and their last good copy kept.

Run: python3 -m unittest scripts/edge/test_edge_ranges.py
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import edge_ranges as er  # noqa: E402

CF_V4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
         "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
         "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
         "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"]
CF_V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
         "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"]
# https://www.arvancloud.ir/en/ips.txt on 2026-10-25: IPv4 only, no final newline.
ARVAN = ["185.143.232.0/22", "188.229.116.16/30", "94.101.182.0/27", "2.144.3.128/28",
         "37.32.16.0/27", "37.32.17.0/27", "37.32.18.0/27", "37.32.19.0/27",
         "185.215.232.0/22", "178.131.120.48/28", "94.101.183.0/28", "78.157.36.112/28",
         "95.38.61.80/28", "193.24.119.0/29"]


def cf_answer(v4=CF_V4, v6=CF_V6, success=True):
    return json.dumps({"success": success, "result": {"ipv4_cidrs": v4, "ipv6_cidrs": v6}})


EDGES = er.load_edges()


class TheList(unittest.TestCase):
    def test_cloudflare_and_arvan_are_listed_with_their_visitor_header(self):
        self.assertEqual(EDGES["cloudflare"]["visitor_header"], "CF-Connecting-IP")
        # NIN-1-a: Arvan overwrites X-Real-IP; X-Forwarded-For keeps a client's value.
        self.assertEqual(EDGES["arvan"]["visitor_header"], "X-Real-IP")

    def test_a_row_missing_a_field_or_naming_an_unknown_format_is_refused(self):
        row = dict(EDGES["arvan"])
        for broken in ({k: v for k, v in row.items() if k != "visitor_header"},
                       {**row, "format": "xml"},
                       {**row, "minimum": {"ipv4": 10}}):
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
                json.dump({"edges": [broken]}, f)
            try:
                with self.assertRaises(er.RangeError, msg=str(broken)):
                    er.load_edges(f.name)
            finally:
                os.unlink(f.name)


class Answers(unittest.TestCase):
    def test_each_edge_answer_is_read_per_family(self):
        self.assertEqual(er.parse(EDGES["cloudflare"], cf_answer()), {4: CF_V4, 6: CF_V6})
        self.assertEqual(er.parse(EDGES["arvan"], "\n".join(ARVAN)), {4: ARVAN, 6: []})

    def test_a_short_malformed_or_failed_answer_is_refused_never_applied(self):
        # An empty chain would drop every visitor: the old rules must stay (O8).
        cf, arvan = EDGES["cloudflare"], EDGES["arvan"]
        for edge, bad in ((cf, cf_answer(v4=[])), (cf, cf_answer(v4=CF_V4[:3])),
                          (cf, cf_answer(v6=["2400:cb00::/32", "nope"])),
                          (cf, cf_answer(v4=CF_V4 + ["0.0.0.0/0"])), (cf, cf_answer(success=False)),
                          (cf, "<html>"), (cf, ""), (arvan, "\n".join(ARVAN[:4])),
                          (arvan, "<html><body>maintenance</body></html>"), (arvan, ""),
                          (arvan, "\n".join(ARVAN + ["2400:cb00::/8"]))):
            with self.assertRaises(er.RangeError, msg=f"{edge['name']}: {bad[:60]}"):
                er.parse(edge, bad)

    def test_a_range_in_the_wrong_family_is_refused(self):
        with self.assertRaises(er.RangeError):
            er.parse(EDGES["cloudflare"], cf_answer(v4=CF_V4 + ["2400:cb00::/32"]))


class Refresh(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.tmp.name, "edge-ranges")
        self.textfile = os.path.join(self.tmp.name, "textfile")
        os.makedirs(self.textfile)
        self.saved = er.STATE_DIR, er.TEXTFILE_DIR
        er.STATE_DIR, er.TEXTFILE_DIR = self.state, self.textfile

    def tearDown(self):
        er.STATE_DIR, er.TEXTFILE_DIR = self.saved
        self.tmp.cleanup()

    def refresh(self, name, body, now):
        def fetch(url):
            if isinstance(body, Exception):
                raise body
            return body
        return er.refresh(EDGES[name], fetch=fetch, now=lambda: now)

    def metrics(self):
        with open(os.path.join(self.textfile, "edge_ranges.prom")) as f:
            return f.read()

    def test_a_good_answer_is_kept_and_its_time_exported(self):
        self.assertEqual(self.refresh("arvan", "\n".join(ARVAN), 1000), {4: ARVAN, 6: []})
        self.assertIn('txnet_edge_ranges_last_refresh_timestamp_seconds{edge="arvan"} 1000', self.metrics())

    def test_a_bad_answer_keeps_the_last_good_copy_and_its_old_time(self):
        self.refresh("arvan", "\n".join(ARVAN), 1000)
        for bad in ("<html>", OSError("timed out")):
            self.assertEqual(self.refresh("arvan", bad, 2000), {4: ARVAN, 6: []})
        # The alert counts from the last good answer, not the last attempt.
        self.assertIn('{edge="arvan"} 1000', self.metrics())

    def test_with_no_good_copy_the_run_fails_and_writes_nothing(self):
        with self.assertRaises(er.RangeError):
            self.refresh("arvan", OSError("unreachable"), 1000)
        self.assertFalse(os.path.exists(os.path.join(self.state, "arvan.json")))

    def test_each_edge_keeps_its_own_copy(self):
        self.refresh("cloudflare", cf_answer(), 1000)
        self.refresh("arvan", "\n".join(ARVAN), 1500)
        self.assertEqual(self.refresh("cloudflare", OSError("down"), 3000), {4: CF_V4, 6: CF_V6})
        text = self.metrics()
        self.assertIn('{edge="cloudflare"} 1000', text)
        self.assertIn('{edge="arvan"} 1500', text)

    def test_a_copy_that_no_longer_meets_the_floor_is_not_used(self):
        # A floor raised in edges.json after the copy was taken still holds.
        os.makedirs(self.state)
        with open(os.path.join(self.state, "arvan.json"), "w") as f:
            json.dump({"edge": "arvan", "fetched_at": 1000, "ipv4": ARVAN[:2], "ipv6": []}, f)
        with self.assertRaises(er.RangeError):
            self.refresh("arvan", OSError("down"), 2000)


if __name__ == "__main__":
    unittest.main()
