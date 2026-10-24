#!/usr/bin/env python3
"""Render a production compose stack into a Kustomize base (ADR-0147, hosting K2, K11).

    python3 tools/k8s_render.py <out-dir> [--stack main|monitoring] [--host-gateway IP] [--tag T]
                                [--sealed DIR | --env-file F...] [--set K=V]...
    python3 tools/k8s_render.py --images [--tag T]   service, local image, registry image per build (K8)
    python3 tools/k8s_render.py --registries [--sealed DIR]   the node's registries.yaml, to stdout (K14)

Compose does the interpolation (`docker compose config`), so a variable means
here exactly what it means to `scripts/prod.compose.sh`. The output holds every
service's environment as Secrets: it is a build artifact, written 0700, never
committed. `--set` overrides a variable the way the shell's environment does
for compose (the rehearsal's `ENVIRONMENT=prod` over dev's env files, K12).
`--stack monitoring` renders the sys-monitor stack into txnet-monitoring and
reads the main stack (its default env files) for the names it calls (K11).
`--sealed DIR` takes the env files and secret files from DIR, where
`tools/k8s_secrets.py open` decrypted them, and never from the checkout (K5).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
from k8srender import RenderError, exposed_ports, render  # noqa: E402
from k8srender.container import built_images  # noqa: E402
from k8srender.registries import registries_yaml  # noqa: E402
from k8srender.tables import STACKS, Stack  # noqa: E402

REPO = Path(__file__).resolve().parent.parent


def compose(stack: Stack, args: list[str], env_files: list[str], overrides: dict) -> str:
    cmd = ["docker", "compose", "-p", stack.project]
    for env_file in env_files:
        cmd += ["--env-file", str(REPO / env_file)]
    for profile in stack.profiles:
        cmd += ["--profile", profile]
    cmd += ["-f", str(REPO / stack.compose), "config", *args]
    return subprocess.run(cmd, check=True, capture_output=True, text=True,
                          env={**os.environ, **overrides}).stdout


def load_model(stack: Stack, env_files: list[str], overrides: dict) -> dict:
    """A production compose model, interpolated by compose itself (K2)."""
    return json.loads(compose(stack, ["--format", "json"], env_files, overrides))


def git_tag() -> str:
    """The default image tag: the commit being deployed (K8)."""
    return subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short=12", "HEAD"],
                          check=True, capture_output=True, text=True).stdout.strip()


def write(out: Path, files: dict) -> None:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, mode=0o700)
    for name, content in files.items():
        docs = content if isinstance(content, list) else [content]
        (out / name).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        (out / name).write_text(yaml.safe_dump_all(docs, sort_keys=False, width=120))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("out", type=Path, nargs="?")
    parser.add_argument("--stack", choices=sorted(STACKS), default="main")
    parser.add_argument("--images", action="store_true", help="list the images to build and push, then exit")
    parser.add_argument("--registries", action="store_true", help="print the node's registries.yaml, then exit")
    parser.add_argument("--tag", help="image tag (default: the current commit)")
    parser.add_argument("--host-gateway", help="the node's address, for compose's host-gateway (K3)")
    parser.add_argument("--env-file", action="append", dest="env_files")
    parser.add_argument("--sealed", type=Path, help="the opened sealed secrets (K5)")
    parser.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    args = parser.parse_args()
    stack = STACKS[args.stack]
    if args.sealed and args.env_files:
        parser.error("--sealed takes the env files from the sealed copies; --env-file would bypass them")

    def env_files_of(of: Stack) -> list[str]:
        return [str(args.sealed / f) for f in of.env_files] if args.sealed else list(of.env_files)
    env_files = args.env_files or env_files_of(stack)
    overrides = dict(kv.split("=", 1) for kv in args.set)
    variables = dict(line.split("=", 1) for line in
                     compose(stack, ["--environment"], env_files, overrides).splitlines() if "=" in line)
    if args.registries:
        try:
            print(registries_yaml(variables), end="")
        except RenderError as error:
            print(f"k8s_render: {error}", file=sys.stderr)
            return 1
        return 0
    options = {"registry": variables.get("LOCAL_DOCKER_REGISTRY", ""), "tag": args.tag or git_tag(),
               "host_gateway": args.host_gateway, "namespace": stack.namespace, "publish": stack.publish,
               "sealed_root": args.sealed}
    if stack.peer:
        peer = STACKS[stack.peer]
        options["peer"] = {"namespace": peer.namespace,
                           "exposed": exposed_ports(load_model(peer, env_files_of(peer), overrides)["services"])}
    model = load_model(stack, env_files, overrides)
    if args.images:
        for row in built_images(model["services"], stack.project, options):
            print("\t".join(row))
        return 0
    if not args.out:
        parser.error("an output directory is required unless --images")
    try:
        files = render(model, REPO, options)
    except RenderError as error:
        print(f"k8s_render: {error}", file=sys.stderr)
        return 1
    write(args.out, files)
    print(f"{len(files)} files in {args.out} (tag {options['tag']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
