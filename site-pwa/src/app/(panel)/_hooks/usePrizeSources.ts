"use client";

import { useEffect, useState } from "react";
import { userGroupsApi, type UserGroup } from "@/lib/auth-api";
import { billingApi, type AdminCoupon } from "@/lib/billing-api";
import { usePanelSession } from "../_context/PanelSessionContext";

/** A list a prize editor offers: loading (`null`), unreadable (`"failed"`, the id is typed instead), or read. */
export type PrizeSource<T> = T[] | null | "failed";

/** The page size a prize editor reads coupons at: every active one a tenant keeps. */
const COUPON_PAGE = 100;

/**
 * What a prize editor (wheel, lottery) picks from: the tenant's own active
 * discount coupons to copy (ADR-0110), not a gift batch's; and the user
 * groups, which `user_group.manage` lists — without it the group id is typed.
 */
export function usePrizeSources(): { templates: PrizeSource<AdminCoupon>; groups: PrizeSource<UserGroup> } {
  const { me } = usePanelSession();
  const tenantId = me?.tenant?.id;
  const [templates, setTemplates] = useState<PrizeSource<AdminCoupon>>(null);
  const [groups, setGroups] = useState<PrizeSource<UserGroup>>(null);
  useEffect(() => {
    let live = true;
    billingApi.adminCoupons({ kind: "discount", status: "active", pageSize: COUPON_PAGE }).then(
      (page) => live && setTemplates(page.items.filter((c) => c.tenantId === tenantId)),
      () => live && setTemplates("failed"),
    );
    userGroupsApi.list().then(
      (list) => live && setGroups(list),
      () => live && setGroups("failed"),
    );
    return () => {
      live = false;
    };
  }, [tenantId]);
  return { templates, groups };
}
