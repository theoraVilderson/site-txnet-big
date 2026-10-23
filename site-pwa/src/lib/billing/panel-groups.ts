// Panel groups and a panel's inbounds on the systems page (F-027-bx, F-114-b).
import { call } from "./client";
import type { JobProgress } from "./reseller-grants";
import type { PanelReviewState, PanelState } from "./systems";

/** `network.ConfigProtocol`: what a panel's inbound serves, and so a config placed on it. */
export type ConfigProtocol = "vmess" | "vless" | "trojan" | "shadowsocks" | "hysteria2" | "tuic" | "wireguard" | "openvpn" | "pppoe" | "router_login";

/** `network.PanelGroupMemberRole` — the member's, not the panel's HA `role`. */
export type PanelGroupMemberRole = "primary" | "replica" | "drain";

/** Where a selling setting's effective value came from (billing `selling-settings.ts`, F-027-cg). */
export type SellingLayer = "member" | "panel" | "platform";

/** Each selling setting's effective value and its layer: member -> panel -> platform default. */
export interface EffectiveSellingSettings {
  inboundPlacement: { value: InboundPlacement; layer: SellingLayer };
  maxClients: { value: number | null; layer: SellingLayer };
  priority: { value: number; layer: SellingLayer };
  weight: { value: number; layer: SellingLayer };
  /** K under `hrw` (F-027-di): how many inbounds a buyer is placed on; platform 2, at most 16. */
  inboundsPerBuyer: { value: number; layer: SellingLayer };
}

/**
 * A member as `panel-groups.ts` `wireMember` answers it: its own selling
 * settings (null = inherited from the panel), their `effective` values, and
 * its panel's health beside it.
 */
export interface PanelGroupMember {
  groupId: string;
  panelId: string;
  inboundPlacement: InboundPlacement | null;
  maxClients: number | null;
  priority: number | null;
  weight: number | null;
  inboundsPerBuyer: number | null;
  effective: EffectiveSellingSettings;
  /** The inbounds assigned to this membership (F-027-ch); `[]` = it sells the panel's pool. */
  inbounds: string[];
  role: PanelGroupMemberRole;
  drainingSince: string | null;
  /** "Remove now" was chosen (F-027-ee): the sweep takes it on its next tick. Only while `drain`. */
  evictedAt: string | null;
  /** What the evict does with a Grant it leaves with no line (F-027-eg); set with `evictedAt`. */
  evictOrphans: EvictOrphans | null;
  evictedBy: string | null;
  /** A draining member's active Grants with no line served elsewhere, which the sweep holds; null when not draining. */
  heldGrants: number | null;
  createdAt: string;
  panelName: string;
  panelState: PanelState;
  reviewState: PanelReviewState;
  lastHealthyAt: string | null;
}

export interface PanelGroup {
  id: string;
  name: string;
  strategy: "mirror" | "priority" | "weighted";
  minHealthyPanels: number;
  subscriptionTtlSeconds: number;
  createdAt: string;
  updatedAt: string;
  /** Variants sold on this group. */
  variantCount: number;
  members: PanelGroupMember[];
}

/** `createPanelGroupSchema`'s fields; `strategy` is never sent (billing rule 21). */
export type PanelGroupBody = Partial<Pick<PanelGroup, "name" | "minHealthyPanels" | "subscriptionTtlSeconds">>;

/**
 * `network.InboundPlacement` (F-114-b): a config on every picked inbound, one
 * on the emptiest, or K by the Grant's rendezvous hash (`hrw`, F-027-di).
 */
export type InboundPlacement = "all" | "spread" | "hrw";

/** One inbound as `network-service` last read it, the admin's pick, and how many live configs it holds. */
export interface PanelInbound {
  remoteId: string;
  tag: string;
  /** Null: a protocol we do not sell — listed, never sellable. */
  protocol: ConfigProtocol | null;
  port: number;
  host: string;
  enabled: boolean;
  /** When a read stopped listing it; null while it is listed. */
  goneAt: string | null;
  seenAt: string;
  sold: boolean;
  maxClients: number | null;
  clients: number;
  /** Sold by every group of the panel, or only by the groups listing it (F-027-ep, ADR-0127). */
  audience: InboundAudience;
  /** The groups a `listed` one is sold by, by name; none on an `every_group` one. */
  listedTo: { id: string; name: string }[];
  /** Every group in scope selling it now, with its share, its own live configs there and a running release (F-027-eu). */
  sellers: InboundSeller[];
}

/** `network.InboundAudience` (F-027-ep). */
export type InboundAudience = "every_group" | "listed";

/** One group selling an inbound: `share` is its listing's cap over its own Grants (F-027-eq), null on none or an every-group one. */
export interface InboundSeller {
  groupId: string;
  name: string;
  share: number | null;
  /** Live configs of this group's Grants on the inbound. */
  clients: number;
  /** A release job taking this group off it, while it runs (F-027-es). */
  releaseJobId: string | null;
}

/** `GET /systems/panels/:id/inbounds` (billing `panel-inbounds.ts`). */
export interface PanelInbounds {
  panelId: string;
  /** The panel's own layer; null = the platform default (F-027-cg). */
  inboundPlacement: InboundPlacement | null;
  maxClients: number | null;
  priority: number | null;
  weight: number | null;
  inboundsPerBuyer: number | null;
  /** Each value as fulfilment reads it for a member that sets none, with `panel` or `platform`. */
  effective: EffectiveSellingSettings;
  /** Null until the first read, and again after a refresh until the next pass reads. */
  inboundsReadAt: string | null;
  /** Grants with a live config on the panel — what `maxClients` caps. */
  users: number;
  /** The panel's groups in scope, by name: whom an inbound's audience can name. */
  members: { id: string; name: string }[];
  inbounds: PanelInbound[];
}

/** `PUT …/inbounds/:remoteId/audience`: every group, or exactly the groups named. */
export type InboundAudienceBody = { audience: "every_group" } | { audience: "listed"; groups: string[] };

/** How a release takes groups off an inbound (F-027-es): their users to the group's next placement, or their configs there removed. */
export type ReleaseMode = "move" | "empty";

export type InboundReleaseBody = { requestId: string; groups: string[]; mode: ReleaseMode; orphans?: EvictOrphans; reason: string };

/** A release job (billing `ConfigMoveJobView`): `total` frozen at the start, the listing changes when it ends. */
export interface InboundReleaseJob extends JobProgress {
  id: string;
  kind: "release_move" | "release_empty";
  source: { panelId: string; remoteId: string; groupIds: string[] };
  orphans: EvictOrphans | null;
  reason: string;
}

/** `updatePanelInboundsSchema`: what is left out keeps its value; null hands a setting to the platform default. */
export type PanelInboundsBody = {
  inboundPlacement?: InboundPlacement | null;
  maxClients?: number | null;
  priority?: number | null;
  weight?: number | null;
  inboundsPerBuyer?: number | null;
  inbounds?: { remoteId: string; sold: boolean; maxClients?: number | null }[];
};

/** A member's own selling settings (F-027-cg): any of them, at least one; null inherits the panel's. */
export type MemberSellingBody = Partial<Pick<PanelGroupMember, "inboundPlacement" | "maxClients" | "priority" | "weight" | "inboundsPerBuyer">>;

export type DrainedMember = PanelGroupMember & { waitSeconds: number };

export type RemovedMember = { groupId: string; panelId: string; removed: true };

export type EvictPreview = { liveConfigs: number; soleLineGrants: number };

/** billing `network.EvictOrphans`: pause a Grant left with no line until a panel joins, or cancel it with a refund. */
export type EvictOrphans = "pause" | "refund";

export type EvictedMember = PanelGroupMember & { soleLineGrants: number };

/** Panel-group and inbound calls — spread into `billingApi` (`lib/billing-api.ts`). */
export const panelGroupCalls = {
  // A panel's inbounds (F-114-b): what the last read found, and which ones a buyer is placed on.

  async panelInbounds(id: string): Promise<PanelInbounds> {
    return call<PanelInbounds>(`/systems/panels/${encodeURIComponent(id)}/inbounds`, { method: "GET" });
  },

  /** 404 `inbound_not_found`, 409 `inbound_not_sellable` (gone, or a protocol we do not sell). */
  async updatePanelInbounds(id: string, body: PanelInboundsBody): Promise<PanelInbounds> {
    return call<PanelInbounds>(`/systems/panels/${encodeURIComponent(id)}/inbounds`, { method: "PUT", body: JSON.stringify(body) });
  },

  /** 202: the panel's next pass (within a minute) reads its inbounds again. */
  async refreshPanelInbounds(id: string): Promise<{ panelId: string; refreshRequested: true }> {
    return call<{ panelId: string; refreshRequested: true }>(`/systems/panels/${encodeURIComponent(id)}/inbounds/refresh`, { method: "POST" });
  },

  // Who sells one inbound, each group's share, and releasing it (F-027-eu -> billing F-027-ep/eq/es).

  /** 409 `inbound_has_configs` when a group would lose it with users there: release it first. */
  async setInboundAudience(panelId: string, remoteId: string, body: InboundAudienceBody): Promise<{ panelId: string; remoteId: string; audience: InboundAudience; groups: string[] }> {
    return call(`/systems/panels/${encodeURIComponent(panelId)}/inbounds/${encodeURIComponent(remoteId)}/audience`, { method: "PUT", body: JSON.stringify(body) });
  },

  /** A listing's share; null clears it. 404 `listing_not_found` on an every-group inbound. */
  async setListingShare(groupId: string, panelId: string, remoteId: string, maxClients: number | null): Promise<{ groupId: string; panelId: string; remoteId: string; maxClients: number | null }> {
    const path = `/systems/panel-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(panelId)}/inbounds/${encodeURIComponent(remoteId)}/share`;
    return call(path, { method: "PUT", body: JSON.stringify({ maxClients }) });
  },

  /** 202 a job; 409 `not_a_seller` / `already_releasing` / `request_reused`. */
  async releaseInbound(panelId: string, remoteId: string, body: InboundReleaseBody): Promise<InboundReleaseJob> {
    return call<InboundReleaseJob>(`/systems/panels/${encodeURIComponent(panelId)}/inbounds/${encodeURIComponent(remoteId)}/release`, { method: "POST", body: JSON.stringify(body) });
  },

  async inboundReleaseJob(jobId: string): Promise<InboundReleaseJob> {
    return call<InboundReleaseJob>(`/systems/inbound-releases/${encodeURIComponent(jobId)}`, { method: "GET" });
  },

  /** What moved stays moved; the listing stays as it was. */
  async cancelInboundRelease(jobId: string): Promise<InboundReleaseJob> {
    return call<InboundReleaseJob>(`/systems/inbound-releases/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
  },

  // Panel groups (F-027-bx -> billing F-027-bw): the platform's, always `mirror`.

  async panelGroups(): Promise<PanelGroup[]> {
    return call<PanelGroup[]>("/systems/panel-groups", { method: "GET" });
  },

  async createPanelGroup(body: PanelGroupBody & { name: string }): Promise<PanelGroup> {
    return call<PanelGroup>("/systems/panel-groups", { method: "POST", body: JSON.stringify(body) });
  },

  /** At least one field; configs already placed stay where they are (billing rule 22). */
  async updatePanelGroup(id: string, body: PanelGroupBody): Promise<PanelGroup> {
    return call<PanelGroup>(`/systems/panel-groups/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
  },

  /** Enters as `primary`; fulfilment places on it once its panel is accepted and healthy. */
  async addPanelGroupMember(groupId: string, panelId: string): Promise<PanelGroupMember> {
    return call<PanelGroupMember>(`/systems/panel-groups/${encodeURIComponent(groupId)}/members`, {
      method: "POST",
      body: JSON.stringify({ panelId }),
    });
  },

  /** A member's own selling settings (F-027-cg); null hands one back to the panel. */
  async updatePanelGroupMember(groupId: string, panelId: string, body: MemberSellingBody): Promise<PanelGroupMember> {
    return call<PanelGroupMember>(`/systems/panel-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(panelId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  /**
   * The membership's whole set of listings (F-027-ep); `[]` lists none and sells the every-group ones.
   * 409 `inbound_has_configs` (`facts.configs`) when another group would lose one with users there.
   */
  async setPanelGroupMemberInbounds(groupId: string, panelId: string, inbounds: string[]): Promise<{ groupId: string; panelId: string; inbounds: string[] }> {
    return call(`/systems/panel-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(panelId)}/inbounds`, {
      method: "PUT",
      body: JSON.stringify({ inbounds }),
    });
  },

  /** 409 `member_has_configs` while a live config of the group's Grants is on it: drain it instead (rule 23). */
  /** Delete a group (F-027-ca): 409 `group_has_members` / `group_in_use` while it has members or a variant names it. */
  async deletePanelGroup(id: string): Promise<{ id: string; removed: true }> {
    return call<{ id: string; removed: true }>(`/systems/panel-groups/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  async removePanelGroupMember(groupId: string, panelId: string): Promise<RemovedMember> {
    return call<RemovedMember>(`/systems/panel-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(panelId)}`, { method: "DELETE" });
  },

  /** Once: a second is 409 `already_draining`. `waitSeconds` is the least the sweep waits from `drainingSince`. */
  async drainPanelGroupMember(groupId: string, panelId: string): Promise<DrainedMember> {
    return call<DrainedMember>(`/systems/panel-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(panelId)}/drain`, {
      method: "POST",
    });
  },

  /** What "remove now" would take: the member's live configs, and the active Grants left with no line (F-027-ee). */
  async panelGroupMemberEvictPreview(groupId: string, panelId: string): Promise<EvictPreview> {
    return call<EvictPreview>(`/systems/panel-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(panelId)}/evict-preview`);
  },

  /** "Remove now": the drain sweep retires its configs on its next tick, no wait, then removes it. A second call keeps the first mark. */
  async evictPanelGroupMember(groupId: string, panelId: string, orphans: EvictOrphans): Promise<EvictedMember> {
    return call<EvictedMember>(`/systems/panel-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(panelId)}/evict`, {
      method: "POST",
      body: JSON.stringify({ orphans }),
    });
  },
};
