import { getValidatedUser, validteToken } from "@lib/auth";
import { getUserData } from "./_actions/getUser";
import DashboardLayout from "./_components/Dashboard";
import "./global.css";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { fullAuthDomain } from "@/env";
import { NextRequest } from "next/server";
import AuthInitializer from "./_components/AuthInitializer";
import { toToman } from "@util/helper";
export default async function layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const userTokenData = await getValidatedUser();
  if (!userTokenData) {
    const redirectUrl = new URL(
      `/login`,
      `https://${fullAuthDomain}`
    ).toString();
    redirect(redirectUrl);
    return null;
  }
  const userData = await getUserData(userTokenData!.userId);
  if (!userData) return null;
  console.log(userData);

  return (
    <>
      <AuthInitializer user={userData}>
        <DashboardLayout>{children}</DashboardLayout>
      </AuthInitializer>
    </>
  );
}
