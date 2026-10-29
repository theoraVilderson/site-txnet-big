#!/usr/bin/env python3
"""Spec for `scripts/release.sh` (OPS-1-ah-d, ADR-0166 point 5, hosting R15).

    python3 tools/release_test.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import release as rl  # noqa: E402
from k8s_staging_data import Production  # noqa: E402

PROD = Production("root@2.144.31.149", "/root/.ssh/key")


class OrderTest(unittest.TestCase):
    def steps(self, log, fail=None):
        def step(name):
            def run():
                log.append(name)
                if name == fail:
                    raise rl.ReleaseError(f"{name} broke")
            return rl.Step(name, run)
        return [step(n) for n in rl.STEP_NAMES]

    def test_the_twin_comes_before_anything_leaves_this_host(self):
        names = list(rl.STEP_NAMES)
        self.assertLess(names.index("build"), names.index("twin"))
        for outward in ("push", "ship", "deploy"):
            self.assertLess(names.index("twin"), names.index(outward), outward)

    def test_a_failed_step_stops_every_later_one(self):
        log = []
        self.assertEqual(rl.run_steps(self.steps(log, fail="twin")), "twin")
        self.assertEqual(log, ["clean", "checks", "disk", "build", "twin"])

    def test_until_stops_after_the_named_step(self):
        log = []
        self.assertIsNone(rl.run_steps(self.steps(log), until="twin"))
        self.assertEqual(log[-1], "twin")
        self.assertNotIn("push", log)

    def test_an_unknown_until_is_refused_before_any_step(self):
        log = []
        with self.assertRaises(rl.ReleaseError):
            rl.run_steps(self.steps(log), until="deploi")
        self.assertEqual(log, [])


class TwinStepTest(unittest.TestCase):
    # ADR-0166 point 6: the dev stack is lent for the run and comes back however it ends.
    def test_staging_comes_down_when_the_twin_fails(self):
        calls = []

        def staging(*argv):
            calls.append(argv[0])
            return argv[0] != "twin"
        with self.assertRaises(rl.ReleaseError):
            rl.twin_step(staging, prod_commit="abc", head="def", staging_up=False)
        self.assertEqual(calls, ["up", "twin", "down"])

    def test_the_twin_starts_from_productions_running_commit(self):
        seen = []

        def staging(*argv):
            seen.append(argv)
            return True
        rl.twin_step(staging, prod_commit="abc", head="def", staging_up=True)
        self.assertEqual(seen[0], ("twin", "--from", "abc", "--to", "def"))
        self.assertEqual(seen[-1], ("down",))


class CleanTest(unittest.TestCase):
    def test_a_changed_checkout_is_refused(self):
        self.assertIn("changed", rl.clean_problem(" M tools/x.py\n", "master"))

    def test_only_master_is_released(self):
        self.assertIn("master", rl.clean_problem("", "HEAD"))

    def test_a_clean_master_passes(self):
        self.assertIsNone(rl.clean_problem("", "master"))


class ShipTest(unittest.TestCase):
    def test_production_moves_forward_only(self):
        command = rl.merge_command("/tmp/r.bundle")
        self.assertIn("merge --ff-only FETCH_HEAD", command)
        self.assertIn(f"git -C {rl.kd.PROD_CHECKOUT} fetch --quiet /tmp/r.bundle", command)

    def test_production_ahead_of_this_checkout_is_refused(self):
        self.assertIn("not an ancestor", rl.ancestry_problem("abc", "def", is_ancestor=False))
        self.assertIsNone(rl.ancestry_problem("abc", "def", is_ancestor=True))

    def test_the_deploy_runs_in_productions_checkout_with_its_address(self):
        command = rl.deploy_command(PROD)
        self.assertTrue(command.startswith(f"cd {rl.kd.PROD_CHECKOUT} && "))
        self.assertIn("HOST_GATEWAY=2.144.31.149 scripts/prod.k8s.sh deploy", command)


if __name__ == "__main__":
    unittest.main()
