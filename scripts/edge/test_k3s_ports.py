"""OPS-1-o-l: k3s's own ports answer localhost and the node, never the public address (hosting K13).

Run: python3 -m unittest scripts/edge/test_k3s_ports.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import edge_chain as ec  # noqa: E402
import k3s_ports as kp  # noqa: E402
from test_cloudflare_firewall import FakeChain  # noqa: E402


class Rules(unittest.TestCase):
    def setUp(self):
        self.jumps = kp.jump_rules("ens192")

    def test_the_chain_drops_whatever_reaches_it(self):
        lines = kp.restore_payload().splitlines()
        self.assertEqual(lines[0], "*filter")
        self.assertIn(f":{kp.CHAIN} - [0:0]", lines)
        self.assertEqual([l for l in lines if l.startswith("-A ")], [f"-A {kp.CHAIN} -j DROP"])
        self.assertEqual(lines[-1], "COMMIT")

    def test_the_api_server_kubelet_and_proxy_health_are_sent_to_it(self):
        self.assertIn(("INPUT", ["-i", "ens192", "-p", "tcp", "-m", "multiport", "--dports", "6443,10250,10256",
                                 "-j", kp.CHAIN]), self.jumps)

    def test_flannels_vxlan_is_sent_to_it(self):
        self.assertIn(("INPUT", ["-i", "ens192", "-p", "udp", "-m", "udp", "--dport", "8472", "-j", kp.CHAIN]),
                      self.jumps)

    def test_a_node_port_is_sent_to_it_from_forward(self):
        # A LoadBalancer Service also gets a NodePort, DNATed to the pod, so it is
        # forwarded and matched on the original port; it would bypass O7's 80/443.
        for proto in ("tcp", "udp"):
            self.assertIn(("FORWARD", ["-i", "ens192", "-p", proto, "-m", "conntrack", "--ctorigdstport",
                                       "30000:32767", "--ctdir", "ORIGINAL", "-j", kp.CHAIN]), self.jumps)

    def test_only_the_public_interface_is_filtered(self):
        # Localhost, cni0 and flannel.1 never carry the public interface's name.
        self.assertTrue(all(args[:2] == ["-i", "ens192"] for _, args in self.jumps))

    def test_web_ports_are_left_to_the_cloudflare_chain(self):
        ports = " ".join(" ".join(args) for _, args in self.jumps)
        self.assertNotIn("443", ports.replace("6443", ""))


class SharedTop(unittest.TestCase):
    """Two edge chains both keep their jumps on top of INPUT. Each decides only
    its own ports, so neither may move the other: a run would otherwise
    reorder INPUT every time the other one ran."""

    def hook(self, rules, target):
        chain = FakeChain("INPUT", rules)
        original, ec.run = ec.run, chain.run
        try:
            jumps = [args for c, args in kp.jump_rules("ens192") if c == "INPUT"]
            ec.hook("iptables", "INPUT", jumps, target)
        finally:
            ec.run = original
        return chain.rules

    def ours(self):
        return [" ".join(args) for c, args in kp.jump_rules("ens192") if c == "INPUT"]

    def test_another_edge_chain_above_ours_is_left_where_it_is(self):
        edge = "-i ens192 -p tcp -m multiport --dports 80,443 -j TXNET-EDGE"
        rules = [edge, *self.ours(), "-j KUBE-ROUTER-INPUT"]
        self.assertEqual(self.hook(list(rules), kp.CHAIN), rules)

    def test_a_kubernetes_rule_above_ours_is_overtaken(self):
        rules = self.hook(["-j KUBE-ROUTER-INPUT", *self.ours()], kp.CHAIN)
        self.assertEqual(rules, [*self.ours(), "-j KUBE-ROUTER-INPUT"])


if __name__ == "__main__":
    unittest.main()
