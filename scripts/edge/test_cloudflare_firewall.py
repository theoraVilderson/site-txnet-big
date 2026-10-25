"""EDGE-1-h, OPS-1-o-g: the production host admits 80/443 from Cloudflare's ranges only.

Run: python3 -m unittest scripts/edge/test_cloudflare_firewall.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import cloudflare_firewall as fw  # noqa: E402
import edge_chain as ec  # noqa: E402
from test_edge_ranges import CF_V4 as V4  # noqa: E402



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

    def test_a_k3s_load_balancer_port_is_sent_to_it_from_forward(self):
        # servicelb's hostPort DNATs 80/443 to a pod, so the packet is forwarded,
        # and there is no DOCKER-USER on a k3s host (K9, OPS-1-o-g).
        jumps = fw.jump_rules("ens192")
        for port in ("80", "443"):
            self.assertIn(("FORWARD", ["-i", "ens192", "-p", "tcp", "-m", "conntrack", "--ctorigdstport", port,
                                       "--ctdir", "ORIGINAL", "-j", fw.CHAIN]), jumps)


class FakeChain:
    """One iptables chain, enough of `-S`, `-C`, `-I n`, `-D n` for hook()."""

    def __init__(self, name, rules):
        self.name, self.rules = name, list(rules)

    def run(self, tool, op, chain, *rest, check=True, stdin=None):
        assert chain == self.name, chain
        spec = " ".join(rest)
        if op == "-S":
            out = "\n".join([f"-P {chain} ACCEPT", *(f"-A {chain} {r}" for r in self.rules)])
            return ec.subprocess.CompletedProcess([], 0, out + "\n", "")
        if op == "-C":
            return ec.subprocess.CompletedProcess([], 0 if spec in self.rules else 1, "", "")
        if op == "-I":
            self.rules.insert(int(rest[0]) - 1, " ".join(rest[1:]))
        elif op == "-D":
            del self.rules[int(rest[0]) - 1]
        return ec.subprocess.CompletedProcess([], 0, "", "")


class Hook(unittest.TestCase):
    JUMPS = [args for chain, args in fw.jump_rules("ens192") if chain == "FORWARD"]
    OURS = [" ".join(a) for a in JUMPS]

    def hook(self, rules):
        chain = FakeChain("FORWARD", rules)
        original, ec.run = ec.run, chain.run
        try:
            ec.hook("iptables", "FORWARD", self.JUMPS, fw.CHAIN)
        finally:
            ec.run = original
        return chain.rules

    def test_the_jumps_go_ahead_of_every_rule_already_there(self):
        # An ACCEPT above ours (Docker's, k3s's) decides first; ours must decide first.
        self.assertEqual(self.hook(["-d 10.42.0.0/16 -j ACCEPT"]), [*self.OURS, "-d 10.42.0.0/16 -j ACCEPT"])

    def test_a_jump_pushed_down_is_moved_back_up_once(self):
        rules = self.hook(["-j KUBE-ROUTER-FORWARD", *self.OURS, "-j FLANNEL-FWD"])
        self.assertEqual(rules, [*self.OURS, "-j KUBE-ROUTER-FORWARD", "-j FLANNEL-FWD"])

    def test_jumps_already_on_top_are_left_alone(self):
        self.assertEqual(self.hook([*self.OURS, "-j FLANNEL-FWD"]), [*self.OURS, "-j FLANNEL-FWD"])


if __name__ == "__main__":
    unittest.main()
