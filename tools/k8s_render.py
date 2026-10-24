#!/usr/bin/env python3
"""Render the production compose stack into a Kustomize base (ADR-0147, hosting K2).

    python3 tools/k8s_render.py <out-dir> --host-gateway IP [--tag T] [--env-file F]... [--set K=V]...
    python3 tools/k8s_render.py --images [--tag T]   service, local image, registry image per build (K8)

Compose does the interpolation (`docker compose config`), so a variable means
here exactly what it means to `scripts/prod.compose.sh`. The output holds every
service's environment as Secrets: it is a build artifact, written 0700, never
committed. `--set` overrides a variable the way the shell's environment does
for compose (the rehearsal's `ENVIRONMENT=prod` over dev's env files, K12).
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
from k8srender import RenderError, render  # noqa: E402
from k8srender.container import built_images  # noqa: E402
from k8srender.tables import PROFILES  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
MAIN_COMPOSE = REPO / "dev-docker/docker-compose.main.yml"
DEFAULT_ENV_FILES = [".env", ".env.prod"]
PROJECT = "txnet"


def compose(args: list[str], env_files: list[str], overrides: dict) -> str:
    cmd = ["docker", "compose", "-p", PROJECT]
    for env_file in env_files:
        cmd += ["--env-file", str(REPO / env_file)]
    for profile in PROFILES:
        cmd += ["--profile", profile]
    cmd += ["-f", str(MAIN_COMPOSE), "config", *args]
    return subprocess.run(cmd, check=True, capture_output=True, text=True,
                          env={**os.environ, **overrides}).stdout


def load_model(env_files: list[str], overrides: dict) -> dict:
    """The production compose model, interpolated by compose itself (K2)."""
    return json.loads(compose(["--format", "json"], env_files, overrides))


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
    parser.add_argument("--images", action="store_true", help="list the images to build and push, then exit")
    parser.add_argument("--tag", help="image tag (default: the current commit)")
    parser.add_argument("--host-gateway", help="the node's address, for compose's host-gateway (K3)")
    parser.add_argument("--env-file", action="append", dest="env_files")
    parser.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    args = parser.parse_args()
    env_files = args.env_files or DEFAULT_ENV_FILES
    overrides = dict(kv.split("=", 1) for kv in args.set)
    variables = dict(line.split("=", 1) for line in
                     compose(["--environment"], env_files, overrides).splitlines() if "=" in line)
    options = {"registry": variables["LOCAL_DOCKER_REGISTRY"], "tag": args.tag or git_tag(),
               "host_gateway": args.host_gateway}
    model = load_model(env_files, overrides)
    if args.images:
        for row in built_images(model["services"], PROJECT, options):
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
