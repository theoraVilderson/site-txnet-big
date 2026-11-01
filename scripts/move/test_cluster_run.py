"""OPS-1-am-g: one command moves production, given the new server's address, port and password or key.

Run: python3 -m unittest scripts/move/test_cluster_run.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import cluster_run as cr  # noqa: E402
import move_access as ma  # noqa: E402

OLD, NEW = "root@193.151.153.11", "root@203.0.113.7"


def state(mode="move", done=(), to=NEW):
    return {"mode": mode, "from": OLD, "from_key": "/k", "to": to, "to_key": "/k",
            "done": {s: 1 for s in done}, "figures": {}}


class Port(unittest.TestCase):
    # the port lives in ~/.ssh/config, so the move, dns_resolvers and the release reach it alike
    def test_a_port_adds_one_block_for_that_address(self):
        text = ma.with_port("Host *\n  ServerAliveInterval 30\n", "203.0.113.7", 2222)
        self.assertIn("Host *\n  ServerAliveInterval 30\n", text)
        self.assertIn("# txnet-move 203.0.113.7\nHost 203.0.113.7\n  Port 2222\n# txnet-move end\n", text)

    def test_a_second_port_replaces_the_first(self):
        text = ma.with_port(ma.with_port("", "203.0.113.7", 2222), "203.0.113.7", 2200)
        self.assertEqual(text.count("Host 203.0.113.7"), 1)
        self.assertIn("Port 2200", text)
        self.assertNotIn("Port 2222", text)

    def test_port_22_needs_no_block(self):
        self.assertEqual(ma.with_port(ma.with_port("", "203.0.113.7", 2222), "203.0.113.7", 22), "")

    def test_another_address_is_left_alone(self):
        text = ma.with_port(ma.with_port("", "198.51.100.1", 2022), "203.0.113.7", 2222)
        self.assertIn("Host 198.51.100.1\n  Port 2022", text)


class Key(unittest.TestCase):
    def test_the_key_is_added_once(self):
        script = ma.install_key_script("ssh-ed25519 AAAA txnet")
        self.assertIn("grep -qxF 'ssh-ed25519 AAAA txnet' /root/.ssh/authorized_keys ||", script)

    def test_password_login_is_switched_off_before_cloud_init_can_switch_it_on(self):
        # sshd takes the first value it reads; Ubuntu's 50-cloud-init.conf may say yes
        self.assertTrue(os.path.basename(ma.KEY_ONLY_CONF).startswith("00-"))
        self.assertIn("PasswordAuthentication no", ma.KEY_ONLY_TEXT)

    def test_only_root_can_move(self):
        self.assertIsNone(ma.refuse_user("root@203.0.113.7"))
        self.assertIn("root", ma.refuse_user("ubuntu@203.0.113.7"))


class Run(unittest.TestCase):
    def run_all(self, st, answers=()):
        ran, asked = [], []
        replies = iter(answers)

        def ask(step):
            asked.append(step)
            return next(replies, "no")

        def step(s, name):
            ran.append(name)
            s["done"][name] = 1

        code = cr.run_all(st, ask=ask, run_step=step)
        return code, ran, asked

    def test_a_rehearsal_runs_through_and_asks_nothing(self):
        code, ran, asked = self.run_all(state("rehearse"))
        self.assertEqual((code, asked), (0, []))
        self.assertEqual(ran, ["check", "mute", "install", "deploy", "bundle", "restore"])

    def test_the_move_asks_before_it_takes_the_platform_down(self):
        code, ran, asked = self.run_all(state())
        self.assertEqual(code, 1)
        self.assertEqual(ran, ["check", "mute", "install", "deploy"])
        self.assertEqual(asked, ["stop"])

    def test_yes_twice_runs_the_whole_move(self):
        code, ran, asked = self.run_all(state(), answers=("yes", "yes"))
        self.assertEqual(code, 0)
        self.assertEqual(asked, ["stop", "repoint"])
        self.assertEqual(ran[-1], "repoint")

    def test_only_the_word_yes_counts(self):
        code, ran, _ = self.run_all(state(), answers=("y",))
        self.assertEqual(code, 1)
        self.assertNotIn("stop", ran)

    def test_a_run_continues_where_it_stopped(self):
        code, ran, _ = self.run_all(state(done=("check", "mute", "install", "deploy", "stop", "bundle")),
                                    answers=("yes",))
        self.assertEqual(ran, ["restore", "fence", "open", "repoint"])
        self.assertEqual(code, 0)

    def test_a_failed_step_stops_the_run_and_names_it(self):
        def boom(s, name):
            if name == "install":
                raise cr.cf.MoveError("no room")
            s["done"][name] = 1
        self.assertEqual(cr.run_all(state(), ask=lambda s: "yes", run_step=boom), 1)


class Resume(unittest.TestCase):
    def test_the_same_unfinished_run_is_continued(self):
        self.assertTrue(cr.continues(state(done=("check",)), "move", OLD, NEW))

    def test_another_server_or_mode_starts_afresh(self):
        self.assertFalse(cr.continues(state(done=("check",)), "move", OLD, "root@198.51.100.1"))
        self.assertFalse(cr.continues(state("rehearse", done=("check",)), "move", OLD, NEW))

    def test_a_finished_run_starts_afresh(self):
        self.assertFalse(cr.continues(state("rehearse", done=cr.cf.STEPS["rehearse"]), "rehearse", OLD, NEW))

    def test_no_run_starts_afresh(self):
        self.assertFalse(cr.continues(None, "move", OLD, NEW))


class ReleaseTarget(unittest.TestCase):
    # OPS-1-am-f: on 2026-10-31 the first release after the move went to the fenced old server
    def test_the_release_follows_the_new_server(self):
        text = "A=1\nSTAGING_PROD_SSH=root@193.151.153.11\nSTAGING_PROD_SSH_KEY=/k\n"
        self.assertEqual(cr.release_target(text, NEW, "/k2"),
                         "A=1\nSTAGING_PROD_SSH=root@203.0.113.7\nSTAGING_PROD_SSH_KEY=/k2\n")

    def test_missing_lines_are_added(self):
        self.assertEqual(cr.release_target("A=1\n", NEW, "/k"),
                         "A=1\nSTAGING_PROD_SSH=root@203.0.113.7\nSTAGING_PROD_SSH_KEY=/k\n")


if __name__ == "__main__":
    unittest.main()
