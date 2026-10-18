"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { UserSearchHit } from "@/lib/auth-api";
import { COUPON_KEYS } from "../_lib/coupon-form";
import { idsOf } from "../_lib/discount-rules";
import { UserSearch } from "../../groups/_components/UserSearch";
import type { MemberSearch } from "../../groups/_lib/user-groups";
import { Button, Textarea } from "../../_components/kit";
import { PickedChips, chipsOf } from "./PickedChips";

const P = COUPON_KEYS.form.picker;

/**
 * Named users, found by name, username or phone (UX-3-a) — a targeted
 * coupon's users and a discount rule's. It is the user-groups page's
 * `UserSearch` through the caller's own door (`memberSearchOf`), and a picked
 * user is a chip with their name. The form keeps its text of ids, so the body
 * sent to billing is the same.
 *
 * A caller with no door (`"ids"`) has the ids box alone; anyone else opens it
 * with "by id". A saved user's name is not looked up again: the chip shows
 * the id's start until they are found once more.
 */
export function UsersPicker({
  id,
  value,
  onChange,
  via,
  tenantId,
  invalid = false,
  busy = false,
}: {
  id?: string;
  value: string;
  onChange: (text: string) => void;
  via: MemberSearch;
  tenantId: string;
  invalid?: boolean;
  busy?: boolean;
}) {
  const { t } = useLocale();
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [byHand, setByHand] = useState(false);

  if (via === "ids" || byHand)
    return (
      <div className="flex flex-col gap-1">
        <Textarea id={id} dir="ltr" rows={3} className="font-mono text-xs" aria-invalid={invalid} value={value} onChange={(e) => onChange(e.target.value)} />
        {via !== "ids" && (
          <Button variant="quiet" size="sm" onClick={() => setByHand(false)} className="self-start text-primary hover:text-primary">
            {t("common", P.fromSearch)}
          </Button>
        )}
      </div>
    );

  const picked = idsOf(value);
  const add = (hit: UserSearchHit) => {
    setNames((m) => new Map(m).set(hit.id, hit.fullName));
    onChange([...picked, hit.id].join("\n"));
  };
  return (
    <div className="flex flex-col gap-2">
      <PickedChips items={chipsOf(picked, (u) => names.get(u))} onRemove={(u) => onChange(picked.filter((x) => x !== u).join("\n"))} disabled={busy} />
      <UserSearch via={via} tenantId={tenantId} onAdd={add} busy={busy} taken={new Set(picked.map((u) => `user:${u}`))} />
      <Button variant="quiet" size="sm" onClick={() => setByHand(true)} className="self-start text-primary hover:text-primary">
        {t("common", P.byId)}
      </Button>
    </div>
  );
}
