"use client";

import { useParams } from "next/navigation";
import { UserServicesView } from "../../../my-resellers/[id]/users/[userId]/_components/UserServicesView";
import { SelfWorkspace } from "../../_components/SelfWorkspace";

/** `/reseller/users/:userId` on a reseller's own domain (F-061-n): one user's services, as `/my-resellers/:id/users/:userId`. */
export default function Page() {
  const { userId } = useParams<{ userId: string }>();
  return (
    <SelfWorkspace>
      {(id) => <UserServicesView id={id} userId={userId} />}
    </SelfWorkspace>
  );
}
