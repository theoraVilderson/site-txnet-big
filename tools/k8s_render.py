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
Before compose reads the model, a missing env file is named with the variables
it has to set.
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


def environment(stack: Stack, env_files: list[str], overrides: dict) -> dict:
    """Every variable as compose reads it from `env_files` and the shell (K2)."""
    return dict(line.split("=", 1) for line in
                compose(stack, ["--environment"], env_files, overrides).splitlines() if "=" in line)


def referenced(stack: Stack, env_files: list[str], overrides: dict) -> dict:
    """Every variable the stack's compose files name, with its default: compose's own list."""
    return json.loads(compose(stack, ["--variables", "--format", "json"], env_files, overrides))


def require_env_files(stack: Stack, env_files: list[str], overrides: dict) -> None:
    """K2, K11 (OPS-1-o-u): a missing env file is named with what only it would
    set — the variables with no default that no other env file sets — instead of
    compose's traceback."""
    missing = [f for f in env_files if not (REPO / f).is_file()]
    if not missing:
        return
    present = [f for f in env_files if f not in missing]
    have = environment(stack, present, overrides)
    needs = sorted(name for name, var in referenced(stack, present, overrides).items()
                   if not var["DefaultValue"] and not have.get(name))
    raise RenderError(f"{', '.join(missing)} is missing: make it (it sets {', '.join(needs) or 'nothing yet'}), "
                      "then `prod.k8s.sh secrets seal` it (S1)")


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
    if args.sealed and args.env_files:
        parser.error("--sealed takes the env files from the sealed copies; --env-file would bypass them")
    if not (args.out or args.images or args.registries):
        parser.error("an output directory is required unless --images or --registries")
    try:
        return run(args)
    except RenderError as error:
        print(f"k8s_render: {error}", file=sys.stderr)
        return 1


def run(args: argparse.Namespace) -> int:
    stack = STACKS[args.stack]

    def env_files_of(of: Stack) -> list[str]:
        return [str(args.sealed / f) for f in of.env_files] if args.sealed else list(of.env_files)
    env_files = args.env_files or env_files_of(stack)
    overrides = dict(kv.split("=", 1) for kv in args.set)
    require_env_files(stack, env_files, overrides)
    variables = environment(stack, env_files, overrides)
    if args.registries:
        print(registries_yaml(variables), end="")
        return 0
    options = {"registry": variables.get("LOCAL_DOCKER_REGISTRY", ""), "tag": args.tag or git_tag(),
               "host_gateway": args.host_gateway, "namespace": stack.namespace, "publish": stack.publish,
               "sealed_root": args.sealed}
    if args.images:
        for row in built_images(load_model(stack, env_files, overrides)["services"], stack.project, options):
            print("\t".join(row))
        return 0
    if stack.peer:
        peer = STACKS[stack.peer]
        options["peer"] = {"namespace": peer.namespace,
                           "exposed": exposed_ports(load_model(peer, env_files_of(peer), overrides)["services"])}
    files = render(load_model(stack, env_files, overrides), REPO, options)
    write(args.out, files)
    print(f"{len(files)} files in {args.out} (tag {options['tag']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
