import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerInviteClaimCard } from "@/components/partner-invite-claim-card";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPartnerInviteTokenForClaim } from "@/lib/partner-invite-token";
import { normalizeInvitedEmail } from "@/lib/partner-invite-token-policy";
import { getCachedClubIdentity } from "@/lib/public-layout-config";

export const dynamic = "force-dynamic";

/**
 * The sign-in affordances on this page are plain, tokenless `/login` links
 * (#2827).
 *
 * They used to be `buildLoginPath('/family-invite/<token>')`, which put the
 * invite token into an `href` — and this page carries the club's normal chrome,
 * which injects admin-authored **Raw CSS**, so `a[href^="/family-invite/9f"]`
 * read the token out one character at a time. Do not reintroduce a callbackUrl
 * here, in any attribute, hidden input or form action.
 *
 * The post-login return address is carried server-side instead, in the HttpOnly
 * cookie `src/lib/family-invite-return-address.ts` documents: `src/proxy.ts`
 * stamps it on every GET of this page, and all four post-login landing sites
 * honour it. The flow still works with JavaScript switched off — these are
 * ordinary anchors, and the cookie rides on the response that rendered them.
 *
 * An absent or expired cookie degrades to the member's ordinary post-login
 * landing, never to an error; the emailed invite link still works.
 */
const LOGIN_PATH = "/login";

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

export default async function PartnerInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [session, view, { name: clubName }] = await Promise.all([
    auth(),
    getPartnerInviteTokenForClaim(token),
    getCachedClubIdentity(),
  ]);

  if (view.status === "invalid") {
    return (
      <Shell title="Invitation link not found">
        <p>This invitation link is invalid or is no longer available.</p>
        <p>
          If you reached this page from an older email, ask the person who
          invited you to send a fresh invitation.
        </p>
      </Shell>
    );
  }

  if (view.status === "expired") {
    return (
      <Shell title="Invitation expired">
        <p>This invitation link has expired.</p>
        <p>
          Ask the person who invited you to send a fresh invitation from their
          family group.
        </p>
      </Shell>
    );
  }

  if (view.status === "claimed") {
    return (
      <Shell title="Invitation already used">
        <p>This invitation has already been accepted.</p>
        <p>
          If you have a {clubName} account, your family group is available from
          your profile page.
        </p>
      </Shell>
    );
  }

  if (view.status === "group_unavailable") {
    return (
      <Shell title="Family group not ready yet">
        <p>
          The family group for this invitation is not available yet. It still
          needs to be approved by an administrator, or it is no longer active.
        </p>
        <p>Check back later, or contact the person who invited you.</p>
      </Shell>
    );
  }

  const groupName = view.groupName ?? "a family group";

  // Not signed in: route the recipient through the normal membership process (do
  // not fork a second registration path). Signing in brings them back here — the
  // return address travels in the #2827 HttpOnly cookie, not in the link, so see
  // LOGIN_PATH above before adding a callbackUrl to either button.
  if (!session?.user?.id) {
    return (
      <Shell title="Family group invitation">
        <p>
          You have been invited to join the family group{" "}
          <strong>{groupName}</strong> at {clubName}.
        </p>
        <p>
          To accept, you first need a {clubName} membership account. Apply for
          membership using the invited email address
          {" "}
          <strong>{view.invitedEmail}</strong>. Once your login is active,
          return to this link to join the group.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button asChild>
            <Link href="/join/apply">Apply for membership</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={LOGIN_PATH}>I already have an account</Link>
          </Button>
        </div>
      </Shell>
    );
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });

  // Signed in with a different email than the invite was sent to: a forwarded
  // link cannot be used to join a stranger's group.
  if (!member || normalizeInvitedEmail(member.email) !== view.invitedEmail) {
    return (
      <Shell title="Family group invitation">
        <p>
          This invitation was sent to <strong>{view.invitedEmail}</strong>.
        </p>
        <p>
          Sign in with that account to accept the invitation to join{" "}
          <strong>{groupName}</strong>.
        </p>
        <div className="pt-2">
          <Button asChild variant="outline">
            <Link href={LOGIN_PATH}>Sign in with a different account</Link>
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Join family group">
      <p>
        You have been invited to join the family group{" "}
        <strong>{groupName}</strong>.
      </p>
      <p>
        Accepting adds you to the group so you can be included when the group
        makes bookings.
      </p>
      {view.createPartnerLink && (
        <p>
          Accepting will <strong>also record you as{" "}
          {view.inviterName ? `${view.inviterName}'s` : "your inviter's"}{" "}
          partner</strong> (husband, wife, or partner) with the club. If that is
          not right, don&apos;t accept — contact the club instead. You can remove
          a recorded partner relationship from your profile at any time.
        </p>
      )}
      <PartnerInviteClaimCard token={token} groupName={groupName} />
    </Shell>
  );
}
