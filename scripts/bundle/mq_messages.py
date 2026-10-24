"""RabbitMQ's queued messages, through its management API (OPS-1-ad).

A bundle cannot copy a running broker's files, so it reads each message
(`get` with requeue: nothing leaves the queue) and a restore publishes it back
to the same queue. A delayed message restarts its window: at most that late.
"""
import base64
import json
import time
import urllib.parse
import urllib.request

MANAGEMENT_PORT = 15672
REQUEST_TIMEOUT_S = 10
# Queues are declared by the services as they connect; a restore waits this long for them.
QUEUE_WAIT_S = 180
# Users (with password hashes), vhosts, permissions, policies, queues, bindings.
# A fresh node gets only the env's user, and only if its first boot completes:
# on the 2026-10-23 restore test a first boot starved by eleven compiling
# services timed out creating it, and the second boot left it with no permissions.
EXPORT_DEFINITIONS = ("rabbitmqctl", "export_definitions", "-", "--format", "json", "-q")
DEFINITIONS_IN_CONTAINER = "/tmp/txnet-definitions.json"
# The env's user as this server's env says: its password and its rights on `/`.
# The password is expanded inside the container, from the variable it already holds.
ENV_USER = (
    'rabbitmqctl list_users -q | cut -f1 | grep -qx "$RABBITMQ_DEFAULT_USER" '
    '|| rabbitmqctl add_user "$RABBITMQ_DEFAULT_USER" "$RABBITMQ_DEFAULT_PASS" -q; '
    'rabbitmqctl change_password "$RABBITMQ_DEFAULT_USER" "$RABBITMQ_DEFAULT_PASS" -q '
    '&& rabbitmqctl set_user_tags "$RABBITMQ_DEFAULT_USER" administrator -q '
    '&& rabbitmqctl set_permissions -p / "$RABBITMQ_DEFAULT_USER" ".*" ".*" ".*" -q'
)


def export_definitions(host):
    return json.loads(host.run(host.exec_argv("rabbitmq", *EXPORT_DEFINITIONS)))


def restore_definitions(host, definitions_path):
    """Imports a bundle's definitions (when it has them), then sets the env's user from this server's env."""
    if definitions_path:
        host.service_box("rabbitmq").put(definitions_path, DEFINITIONS_IN_CONTAINER)
        host.run(host.exec_argv("rabbitmq", "rabbitmqctl", "import_definitions", DEFINITIONS_IN_CONTAINER, "-q"))
    host.run(host.exec_argv("rabbitmq", "sh", "-c", ENV_USER))


class Broker:
    """The management API of the stack's rabbitmq at `base` (the stack's management_url)."""

    def __init__(self, host, base):
        user, password = (host.run(host.exec_argv("rabbitmq", "printenv", name)).strip()
                          for name in ("RABBITMQ_DEFAULT_USER", "RABBITMQ_DEFAULT_PASS"))
        self.base = base
        self.auth = "Basic " + base64.b64encode(("%s:%s" % (user, password)).encode()).decode()
        # the host's proxy (if any) cannot reach a bridge address or a port-forward
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data,
                                         headers={"Authorization": self.auth, "content-type": "application/json"})
        with self.opener.open(request, timeout=REQUEST_TIMEOUT_S) as response:
            return json.load(response)

    def queue_names(self):
        return {q["name"] for q in self.call("queues/%2F")}


def save(broker):
    """Every queued message, left in its queue: [{queue, properties, payload}]."""
    saved = []
    for queue in broker.call("queues/%2F"):
        if not queue.get("messages"):
            continue
        path = "queues/%%2F/%s/get" % urllib.parse.quote(queue["name"], safe="")
        got = broker.call(path, {"count": queue["messages"], "ackmode": "ack_requeue_true", "encoding": "base64"})
        saved += [{"queue": queue["name"], "properties": m["properties"], "payload": m["payload"]} for m in got]
    return saved


def load(broker, messages):
    """Publishes messages back once their queues exist; returns those not routed."""
    wanted = {m["queue"] for m in messages}
    deadline = time.monotonic() + QUEUE_WAIT_S
    while wanted - broker.queue_names() and time.monotonic() < deadline:
        time.sleep(3)
    lost = []
    for message in messages:
        body = {"routing_key": message["queue"], "properties": message["properties"],
                "payload": message["payload"], "payload_encoding": "base64"}
        if not broker.call("exchanges/%2F/amq.default/publish", body).get("routed"):
            lost.append(message["queue"])
    return lost
