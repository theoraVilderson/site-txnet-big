"""The mirrors switch: one committed file, two profiles (ADR-0170, contract.mirrors.md).

Run: python3 -m unittest scripts/mirrors/test_mirrors.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import mirrors as mi  # noqa: E402

REPO = Path(__file__).resolve().parent.parent.parent
LOCAL = "DOCKER_REGISTRY=registry.example\nPKG_MIRROR=https://packages.example/repository\n" \
        "APK_MIRROR=https://packages.example/repository/alpine\n"
UPSTREAM = "DOCKER_REGISTRY=docker.example\nPKG_MIRROR=\nAPK_MIRROR=https://alpine.example/alpine\n"


def tree(profiles):
    root = Path(tempfile.mkdtemp())
    (root / "scripts" / "mirrors").mkdir(parents=True)
    for name, text in profiles.items():
        (root / "scripts" / "mirrors" / f"{name}.env").write_text(text)
    return root


class Switch(unittest.TestCase):
    def test_a_switch_writes_the_profile_and_names_it(self):
        root = tree({"local": LOCAL, "upstream": UPSTREAM})
        mi.switch("upstream", root)
        name, values = mi.active(root)
        self.assertEqual(name, "upstream")
        self.assertEqual(values, {"DOCKER_REGISTRY": "docker.example", "PKG_MIRROR": "",
                                  "APK_MIRROR": "https://alpine.example/alpine"})

    def test_it_returns_what_changed(self):
        root = tree({"local": LOCAL, "upstream": UPSTREAM})
        mi.switch("local", root)
        self.assertEqual(mi.switch("upstream", root), ["APK_MIRROR", "DOCKER_REGISTRY", "PKG_MIRROR"])
        self.assertEqual(mi.switch("upstream", root), [])

    def test_a_profile_missing_a_variable_is_refused(self):
        root = tree({"local": "DOCKER_REGISTRY=registry.example\n"})
        with self.assertRaises(mi.MirrorsError):
            mi.switch("local", root)

    def test_an_unknown_profile_is_refused(self):
        with self.assertRaises(mi.MirrorsError):
            mi.switch("offline", tree({"local": LOCAL}))

    def test_a_hand_edit_is_reported_as_no_profile(self):
        root = tree({"local": LOCAL, "upstream": UPSTREAM})
        mi.switch("local", root)
        path = root / mi.ACTIVE
        path.write_text(path.read_text().replace("registry.example", "elsewhere.example"))
        self.assertIsNone(mi.matching(root))
        mi.switch("local", root)
        self.assertEqual(mi.matching(root), "local")


class Repo(unittest.TestCase):
    # the committed file is always one of the committed profiles, whole
    def test_the_committed_mirrors_env_is_a_profile(self):
        self.assertIn(mi.matching(REPO), mi.profiles(REPO))

    def test_every_profile_names_every_variable(self):
        for name in mi.profiles(REPO):
            self.assertEqual(set(mi.profile(name, REPO)), set(mi.KEYS), name)


if __name__ == "__main__":
    unittest.main()
