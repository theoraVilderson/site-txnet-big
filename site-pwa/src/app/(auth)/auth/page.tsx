import { redirect } from "next/navigation";
import { AUTH_LOGIN } from "@/lib/routes";

export default function AuthIndexPage() {
  redirect(AUTH_LOGIN);
}
