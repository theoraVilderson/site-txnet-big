#!/usr/bin/env python3
"""Spec for the twin run (OPS-1-ah-c, ADR-0166 points 4, 5).

    python3 tools/k8s_staging_twin_test.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_staging_twin as kt  # noqa: E402


class OrderTest(unittest.TestCase):
    # ADR-0166 point 4: the new release lands on the old one holding production's
    # data, so the migration and the roll run as they will there; checks after.
    # ADR-0168: the guard runs once that migration has, before any check.
    def test_from_restored_then_to_deployed_then_checked(self):
        steps = []
        stages = kt.Stages(restore=lambda ref: steps.append(("restore", ref)),
                           deploy=lambda ref: steps.append(("deploy", ref)),
                           guard=lambda: steps.append(("guard",)),
                           checks={"ready": lambda: steps.append(("ready",)) or True,
                                   "roll": lambda: steps.append(("roll",)) or False,
                                   "panels": lambda: steps.append(("panels",)) or True})
        results = kt.run(stages, "old", "new")
        self.assertEqual(steps[:3], [("restore", "old"), ("deploy", "new"), ("guard",)])
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
