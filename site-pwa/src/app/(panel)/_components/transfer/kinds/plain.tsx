"use client";

import { Field, Input } from "../../kit";
import type { AdminFieldsProps } from "../transfer-kind";

/**
 * A kind the panel has no drawing for yet (principle 1's fallback): the
 * destination's stored fields as plain text boxes, named as billing names
 * them. It edits what is there and adds nothing; billing's kind checks it.
 */
export function PlainAdminFields({ fields, onChange }: AdminFieldsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {Object.keys(fields).map((id) => (
        <Field key={id} label={<span dir="ltr">{id}</span>}>
          <Input dir="ltr" value={fields[id]} onChange={(e) => onChange(id, e.target.value)} />
        </Field>
      ))}
    </div>
  );
}
