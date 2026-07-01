import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildLoginPath, resolvePostLoginPath } from "@/lib/auth-redirect";
import { TwoFactorVerifyPanel } from "../two-factor-panels";

function singleSearchParam(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function TwoFactorVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const params = await searchParams;
  const callbackUrl = resolvePostLoginPath(
    singleSearchParam(params.callbackUrl),
  );
  const session = await auth();

  if (!session?.user) {
    redirect(buildLoginPath(callbackUrl));
  }

  if (session.user.forcePasswordChange) {
    redirect("/change-password");
  }

  if (!session.user.twoFactorRequired || session.user.twoFactorVerified) {
    redirect(callbackUrl);
  }

  if (!session.user.twoFactorEnrolled || !session.user.twoFactorMethod) {
    const query = new URLSearchParams({ callbackUrl });
    redirect(`/login/enroll?${query.toString()}`);
  }

  return (
    <TwoFactorVerifyPanel
      callbackUrl={callbackUrl}
      enrolledMethod={session.user.twoFactorMethod}
    />
  );
}
