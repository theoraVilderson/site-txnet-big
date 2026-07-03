Infra: Development vs Production

Goals

- Use `docker compose` for development (single-host, local mounts).
- Use Docker Swarm for production to allow adding nodes and autoscaling.
- Ensure `monitoring-tower` integrates with both environments.

Files added

- `docker-compose.dev.yml` — network and volume overrides for development.
- `docker-stack.yml` — swarm-specific overrides and global services (promtail, node-exporter).

Development workflow

1. Start services locally with Compose:

```bash
# from repo root
docker compose -f compose.yml -f docker-compose.dev.yml up --build
```

2. For services you iterate on, enable mounts in `docker-compose.dev.yml` (example included).

Production workflow (Swarm)

1. Initialize swarm on manager node:

```bash
docker swarm init --advertise-addr <MANAGER_IP>
```

2. Join workers using the token printed by `docker swarm join-token worker`.

3. Deploy the stack:

```bash
docker stack deploy -c compose.yml -c docker-stack.yml txnet
```

Monitoring integration

- `monitoring-tower/sys-monitor/docker-compose.sys-monitor.yml` is already prepared for swarm.
- It uses `private_backend_network` external network; ensure the same network exists in swarm:

```bash
docker network create --driver overlay --attachable private_backend_network
```

Notes and next steps

- Review secrets and environment variables for production (use Docker secrets and external registries).
- Optionally split `compose.yml` into `compose.base.yml` + `compose.dev.yml` for clarity.

- Helper: ensure networks exist

  A small helper script `scripts/ensure-networks.sh` is provided to create the expected networks before starting stacks.

  Usage:

  ```bash
  # create dev (bridge) networks
  ./scripts/ensure-networks.sh dev

  # create prod (overlay) networks on a manager node
  ./scripts/ensure-networks.sh prod
  ```

**Monitoring deployment**

- Recommendation: keep monitoring as a separate stack (`monitoring-tower`) for production (Swarm) so it can run global services like `promtail`, `node-exporter`, and `cadvisor` on every node. For development you can run it with `docker compose` locally when needed.

- Development (local): from `monitoring-tower/sys-monitor` run:

```bash
cd monitoring-tower/sys-monitor
./dev.compose.sh up -d
```

This uses `docker compose` and the environment file `.env.dev` in that folder.

- Production (swarm): create the overlay network and deploy the monitoring stack separately:

```bash
# on a manager node
docker network create --driver overlay --attachable private_backend_network
cd monitoring-tower/sys-monitor
docker stack deploy -c docker-compose.sys-monitor.yml txnet_monitor
```

- Notes:
  - `promtail`, `node-exporter`, and `cadvisor` are configured with `deploy.mode: global` so they run on every node automatically when the stack is deployed in Swarm.
  - Ensure the configs referenced (e.g., `config-${ENV_NAME}/prometheus.yml`) and secret files exist on the manager before deploying the stack.
  - Keep monitoring separate from the main app stack to allow independent scaling and lifecycle (upgrades, restarts) and to avoid coupling credentials/configs between app and monitoring services.
