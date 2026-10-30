#!/usr/bin/env python3
"""Spec for `scripts/release.sh` (OPS-1-ah-d, -k; ADR-0166 point 5, ADR-0168 point 4; hosting R15).

    python3 tools/release_test.py
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import release as rl  # noqa: E402
from k8s_staging_data import Production  # noqa: E402

PROD = Production("root@2.144.31.149", "/root/.ssh/key")


class OrderTest(unittest.TestCase):
    def steps(self, log, names=None, fail=None):
        def step(name):
            def run():
                log.append(name)
                if name == fail:
                    raise rl.ReleaseError(f"{name} broke")
            return rl.Step(name, run)
        return [step(n) for n in names or rl.PROVE_STEPS]

    def test_proving_sends_nothing(self):
        # ADR-0168 point 4: production never goes on its own.
        self.assertEqual(rl.PROVE_STEPS[-1], "twin")
        for outward in ("push", "ship", "deploy"):
            self.assertNotIn(outward, rl.PROVE_STEPS)
            self.assertIn(outward, rl.SEND_STEPS)

    def test_sending_checks_the_approval_first_and_frees_staging_last(self):
        self.assertEqual(rl.SEND_STEPS[0], "approved")
        self.assertEqual(rl.SEND_STEPS[-1], "close")

    def test_a_failed_step_stops_every_later_one(self):
        log = []
        self.assertEqual(rl.run_steps(self.steps(log, fail="build")), "build")
        self.assertEqual(log, ["clean", "checks", "disk", "build"])

    def test_until_stops_after_the_named_step(self):
        log = []
        self.assertIsNone(rl.run_steps(self.steps(log), until="disk"))
        self.assertEqual(log[-1], "disk")
        self.assertNotIn("twin", log)

    def test_an_unknown_until_is_refused_before_any_step(self):
        log = []
        with self.assertRaises(rl.ReleaseError):
            rl.run_steps(self.steps(log), until="deploy")
        self.assertEqual(log, [])


class TwinStepTest(unittest.TestCase):
    # ADR-0166 point 6: the dev stack comes back when the twin fails; ADR-0168
    # point 4: a passed twin leaves staging up for the owner to test.
    def test_staging_comes_down_when_the_twin_fails(self):
        calls = []

        def staging(*argv):
            calls.append(argv[0])
            return argv[0] != "twin"
        with self.assertRaises(rl.ReleaseError):
            rl.twin_step(staging, prod_commit="abc", head="def", staging_up=False)
        self.assertEqual(calls, ["up", "twin", "down"])

    def test_a_passed_twin_leaves_staging_up(self):
        seen = []

        def staging(*argv):
            seen.append(argv)
            return True
        rl.twin_step(staging, prod_commit="abc", head="def", staging_up=True)
        self.assertEqual(seen, [("twin", "--from", "abc", "--to", "def")])


HEAD = "d" * 40
PROD_AT = "a" * 40


class ApprovalTest(unittest.TestCase):
    def proved(self, **extra):
        return {"commit": HEAD, "production": PROD_AT, **extra}

    def test_the_owner_approves_in_a_terminal_by_typing_the_commit(self):
        self.assertIsNone(rl.approval_problem(self.proved(), HEAD, HEAD[:12], is_tty=True))

    def test_no_terminal_no_approval(self):
        # An agent's shell has no terminal: the approval stays the owner's.
        self.assertIn("terminal", rl.approval_problem(self.proved(), HEAD, HEAD[:12], is_tty=False))

    def test_a_mistyped_commit_is_refused(self):
        self.assertIn("not approved", rl.approval_problem(self.proved(), HEAD, "dddd", is_tty=True))

    def test_only_a_commit_whose_twin_passed_can_be_approved(self):
        self.assertIn("twin", rl.approval_problem(None, HEAD, HEAD[:12], is_tty=True))
        self.assertIn("twin", rl.approval_problem(self.proved(commit="e" * 40), HEAD, HEAD[:12], is_tty=True))

    def test_send_needs_the_approval_of_this_same_commit(self):
        approved = self.proved(approved_by="root")
        self.assertIsNone(rl.send_problem(approved, HEAD, PROD_AT))
        self.assertIn("approve", rl.send_problem(self.proved(), HEAD, PROD_AT))
        self.assertIn("twin", rl.send_problem(None, HEAD, PROD_AT))
        # A newer commit needs a new approval (ADR-0168 point 4).
        self.assertIn("twin", rl.send_problem(approved, "e" * 40, PROD_AT))

    def test_send_refuses_when_production_moved_since_the_twin(self):
        self.assertIn("production", rl.send_problem(self.proved(approved_by="root"), HEAD, "b" * 40))

    def test_the_record_survives_a_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d, "sub", "release.json")
            self.assertIsNone(rl.read_record(path))
            rl.write_record(path, self.proved())
            self.assertEqual(rl.read_record(path)["commit"], HEAD)


class CleanTest(unittest.TestCase):
    def test_a_changed_checkout_is_refused(self):
        self.assertIn("changed", rl.clean_problem(" M tools/x.py\n", "master"))

    def test_only_master_is_released(self):
        self.assertIn("master", rl.clean_problem("", "HEAD"))

    def test_a_clean_master_passes(self):
        self.assertIsNone(rl.clean_problem("", "master"))


class ShipTest(unittest.TestCase):
    def test_production_moves_forward_only(self):
        self.assertIn("merge --ff-only FETCH_HEAD", rl.merge_command("/tmp/r.bundle"))

    def test_the_bundle_ship_makes_fast_forwards_a_checkout(self):
        # 2026-10-29: the first release asked the bundle for HEAD, which a
        # `prod..master` bundle does not carry ("couldn't find remote ref HEAD").
        with tempfile.TemporaryDirectory() as d:
            here, there, bundle = Path(d, "here"), Path(d, "there"), Path(d, "r.bundle")
            git = lambda repo, *a: subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True,
                                                  text=True).stdout.strip()
            subprocess.run(["git", "init", "-q", "-b", rl.RELEASE_BRANCH, str(here)], check=True)
            ident = ("-c", "user.email=t@t", "-c", "user.name=t")
            git(here, *ident, "commit", "-q", "--allow-empty", "-m", "prod")
            subprocess.run(["git", "clone", "-q", str(here), str(there)], check=True)
            prod = git(here, "rev-parse", "HEAD")
            git(here, *ident, "commit", "-q", "--allow-empty", "-m", "release")
            git(here, "bundle", "create", "--quiet", str(bundle), *rl.bundle_range(prod))
            subprocess.run(rl.merge_command(str(bundle), checkout=str(there)), shell=True, check=True,
                           capture_output=True)
            self.assertEqual(git(there, "rev-parse", "HEAD"), git(here, "rev-parse", "HEAD"))

    def test_production_ahead_of_this_checkout_is_refused(self):
        self.assertIn("not an ancestor", rl.ancestry_problem("abc", "def", is_ancestor=False))
        self.assertIsNone(rl.ancestry_problem("abc", "def", is_ancestor=True))

    def test_the_deploy_runs_in_productions_checkout_with_its_address(self):
        command = rl.deploy_command(PROD)
        self.assertTrue(command.startswith(f"cd {rl.kd.PROD_CHECKOUT} && "))
        self.assertIn("HOST_GATEWAY=2.144.31.149 scripts/prod.k8s.sh deploy", command)


if __name__ == "__main__":
    unittest.main()
