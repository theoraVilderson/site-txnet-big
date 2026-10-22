// A user's own move of one config to another server (network contract.config-move.md "Self-move", F-410).
import { call } from "./client";

/** One server a config may move to: its id and region, never its name or address (F-410-b). */
export interface MoveTargetPanel {
  id: string;
  region: string;
}

/**
 * Where a config may move, and from when (`GET /traffic/configs/:id/move-targets`).
 * The Grant's answer, read through one of its configs: the wait is the Grant's.
 */
export interface ConfigMoveTargets {
  configId: string;
  /** The reseller's switch, as it resolved for this service's product. */
  enabled: boolean;
  cooldownHours: number;
  /** ISO time the wait ends; null when a move is allowed now. */
  nextMoveAt: string | null;
  panels: MoveTargetPanel[];
}

/** What a move answers: the new config, where it is served, and when the next move is allowed. */
export interface ConfigMoved {
  retiredConfigId: string;
  configId: string;
  panel: MoveTargetPanel;
  nextMoveAt: string | null;
}

export const configMoveCalls = {
  /** 404 for another user's, a missing or a retired config. */
  async configMoveTargets(configId: string): Promise<ConfigMoveTargets> {
    return call<ConfigMoveTargets>(`/traffic/configs/${encodeURIComponent(configId)}/move-targets`, { method: "GET" });
  },

  /**
   * Moves the config at once (F-410-c). Refused 404 `not_a_target`, 409
   * `move_disabled`, `placed_by_group`, and `move_cooldown` with `facts {nextAtMs}`.
   * The new config's lines arrive later, on `network.grant.linksCaptured`.
   */
  async moveConfig(configId: string, toPanelId: string): Promise<ConfigMoved> {
    return call<ConfigMoved>(`/traffic/configs/${encodeURIComponent(configId)}/move`, {
      method: "POST",
      body: JSON.stringify({ toPanelId }),
    });
  },
};
