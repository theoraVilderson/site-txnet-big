#!/usr/bin/env python3
"""Read a built Kustomize manifest for `scripts/prod.k8s.sh deploy` (hosting K10).

    python3 tools/k8s_manifest.py stores <manifest>     the manifest without its Deployments and DaemonSets
    python3 tools/k8s_manifest.py workloads <manifest>  one `namespace:kind/name` per workload

`deploy` applies the stores first, so db-migrate finds Postgres and its Secret
before any Deployment exists (K8), then waits on every workload's rollout in
its own namespace (K11's are in txnet-monitoring).
"""
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
from k8srender.tables import NAMESPACE  # noqa: E402

_ROLLED_OUT = ("StatefulSet", "Deployment", "DaemonSet")
# Rolled out only after db-migrate: everything that runs application code.
_AFTER_MIGRATE = {"Deployment", "DaemonSet"}


def stores(manifest: str) -> str:
    """Every object except the Deployments and DaemonSets, as one YAML stream."""
    kept = [o for o in yaml.safe_load_all(manifest) if o and o["kind"] not in _AFTER_MIGRATE]
    return yaml.safe_dump_all(kept, sort_keys=False, width=120)


def workloads(manifest: str) -> list[str]:
    """The objects `kubectl rollout status` can wait on, data stores first."""
    objects = [o for o in yaml.safe_load_all(manifest) if o and o["kind"] in _ROLLED_OUT]
    objects.sort(key=lambda o: _ROLLED_OUT.index(o["kind"]))
    return [f"{o['metadata'].get('namespace', NAMESPACE)}:{o['kind'].lower()}/{o['metadata']['name']}"
            for o in objects]


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("stores", "workloads"):
        print(__doc__, file=sys.stderr)
        return 2
    manifest = Path(sys.argv[2]).read_text()
    print(stores(manifest) if sys.argv[1] == "stores" else "\n".join(workloads(manifest)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
