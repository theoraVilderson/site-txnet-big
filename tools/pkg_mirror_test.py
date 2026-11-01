#!/usr/bin/env python3
"""Spec for the package mirror's URL rewrite (pkg_mirror.py).

    python3 tools/pkg_mirror_test.py
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import pkg_mirror as pm  # noqa: E402

MIRROR = "https://packages.example/repository"


class Mirrored(unittest.TestCase):
    def test_a_github_release_keeps_its_path_under_the_github_repo(self):
        self.assertEqual(pm.mirrored("https://github.com/k3s-io/k3s/releases/download/v1.34.1%2Bk3s1/k3s", MIRROR),
                         MIRROR + "/github/k3s-io/k3s/releases/download/v1.34.1%2Bk3s1/k3s")

    def test_raw_github_goes_to_its_own_repo(self):
        self.assertEqual(pm.mirrored("https://raw.githubusercontent.com/k3s-io/k3s/v1/install.sh", MIRROR),
                         MIRROR + "/github-raw/k3s-io/k3s/v1/install.sh")

    def test_a_plus_in_the_path_is_written_as_2b(self):
        # Nexus reads a bare `+` as a space; GitHub takes either
        self.assertEqual(pm.mirrored("https://raw.githubusercontent.com/k3s-io/k3s/v1.34.1+k3s1/install.sh", MIRROR),
                         MIRROR + "/github-raw/k3s-io/k3s/v1.34.1%2Bk3s1/install.sh")

    def test_no_mirror_leaves_the_url_as_it_was(self):
        url = "https://github.com/getsops/sops/releases/download/v3/sops"
        self.assertEqual(pm.mirrored(url, ""), url)

    def test_a_host_the_mirror_has_no_repo_for_is_refused(self):
        with self.assertRaises(ValueError):
            pm.mirrored("https://example.org/file", MIRROR)


class Configured(unittest.TestCase):
    def test_the_environment_wins_over_mirrors_env(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "mirrors.env").write_text("PKG_MIRROR=https://from-file/repository  # note\n")
            self.assertEqual(pm.configured(Path(root), {"PKG_MIRROR": MIRROR}), MIRROR)
            self.assertEqual(pm.configured(Path(root), {}), "https://from-file/repository")

    def test_an_empty_environment_value_turns_the_mirror_off(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "mirrors.env").write_text("PKG_MIRROR=https://from-file/repository\n")
            self.assertEqual(pm.configured(Path(root), {"PKG_MIRROR": ""}), "")

    def test_no_mirrors_env_means_no_mirror(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(pm.configured(Path(root), {}), "")



class Environ(unittest.TestCase):
    # ADR-0170: a tree from before mirrors.env (production's commit in the twin) reads
    # only .env; compose takes the shell's values over every env file, so they ride there
    def test_mirrors_env_s_variables_without_the_profile_name(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "mirrors.env").write_text("MIRRORS_PROFILE=local\nDOCKER_REGISTRY=registry.example\n"
                                                    "PKG_MIRROR=\nAPK_MIRROR=https://alpine.example\n")
            self.assertEqual(pm.environ(Path(root)), {"DOCKER_REGISTRY": "registry.example", "PKG_MIRROR": "",
                                                      "APK_MIRROR": "https://alpine.example"})


if __name__ == "__main__":
    unittest.main()
