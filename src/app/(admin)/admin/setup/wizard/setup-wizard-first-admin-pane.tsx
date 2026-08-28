"use client";

import { useId, useState, type FormEvent } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";

import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { isFullAdmin } from "@/lib/access-roles";
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "@/lib/member-setup-invite";
import { emitSetupReadinessInputChanged } from "@/lib/setup-readiness-events";

/**
 * The `seed-admin` step's inline pane (epic #213, child C20; owner decision
 * D18, dossier §B.2).
 *
 * ## Why this one is BUILT rather than embedded
 *
 * Every other pane in `setup-wizard-panes.tsx` mounts a settings section that
 * already exists somewhere else — that is the parity rule D8 wrote, and it is
 * what keeps the wizard from growing a second editor for facts a real screen
 * already owns. There is no such section here, and the registry entry this
 * replaces said so precisely: the member editor is a per-record surface that
 * needs a chosen member before it can render anything, and
 * `MemberEditorDialog` is a full membership form inside a `Dialog` — a separate
 * accessibility container, seventy-odd fields, and a create path that is one
 * branch of an edit path. Mounting it here would put the club's entire
 * membership editor inside the setup wizard to collect three strings.
 *
 * So this is a NEW component, and it is deliberately the smallest one that can
 * satisfy the step: an email, a name, and whether to send the invite. It is not
 * a second member editor and must not grow into one — anything beyond
 * "somebody other than the seed account can administer this club" belongs on
 * `/admin/members`, which the frame still links to.
 *
 * ## SCOPE: create only
 *
 * Retiring the seeded account is explicitly NOT here (issue #251, and the
 * dossier's three unresolved facts behind it: the operator is signed in AS the
 * seed account, `adminCount` is `active: true`-scoped so retiring first flips
 * the step from `complete` to `blocked`, and no self-deactivation guard has
 * been verified). That needs its own decision and its own child.
 *
 * ## THE COLUMN THE READINESS CHECK COUNTS
 *
 * `setup-readiness-db.ts` counts the LEGACY role column —
 * `prisma.member.count({ where: { role: "ADMIN", active: true } })` — while the
 * authorisation path the rest of the admin tree uses is the `accessRoles`
 * tokens. Those two can disagree, and the trap is real: a member created with
 * `accessRoles: ["ADMIN_MEMBERSHIP"]` gets `role: "USER"`, so an operator
 * creates a working Membership Officer and this step stays amber.
 *
 * They do NOT disagree for the token this pane sends, and that is why the pane
 * sends it rather than the check being re-pointed. `createAdminMember` derives
 * the legacy column from the tokens on every create —
 * `legacyRole = data.accessRoles !== undefined ? legacyRoleFromAccessRoles(accessRoles) : data.role`
 * (`admin-members-service.ts`) — and `legacyRoleFromAccessRoles` returns
 * `"ADMIN"` exactly when the token set holds `"ADMIN"` (`access-roles.ts`). The
 * member edit path (`admin-member-detail-service.ts`) and the edit-group
 * builder (`admin-member-edit-groups.ts`) derive it the same way. So on every
 * write path through the admin services, `role === "ADMIN"` IS "holds the Full
 * Admin token", which is also the only thing `isFullAdmin` has ever meant.
 * Re-pointing the count at `MemberAccessRole` would select the same members,
 * cost a join in a snapshot that `npm run setup:check` also builds, and buy
 * nothing. Sending the token is one field.
 *
 * **This is load-bearing and it is pinned.** Delete `accessRoles: ["ADMIN"]`
 * from the body below and the create still succeeds, the operator still gets a
 * success toast, and the step stays amber for ever — the exact defect, wearing
 * a green save. `setup-wizard-first-admin-pane.test.tsx` fails if the token
 * leaves the payload.
 *
 * ## Why it also asks for Full Admin before showing the form
 *
 * The step's permission area is `membership` (`SETUP_STEP_PERMISSION_AREA`),
 * matching `POST /api/admin/members`'s own `membership: edit` guard — so the
 * pane mounts for a Membership Officer. But granting a privileged access role
 * needs Full Admin ON TOP of that (#1012's separation of duties, enforced in
 * `createAdminMember` before anything is written), so that officer's create
 * would answer 403. This replicates the shell test the same way
 * `ClubTimeZoneWizardPane` does for `/admin/club-time`, including the
 * `session &&` guard so the refusal cannot flash at the administrators who ARE
 * allowed in. The server is the real gate either way; this only stops the
 * screen offering an action it already knows will be refused.
 *
 * That branch returns ABOVE the first branch that mounts the view-only banner,
 * which is the shape `view-only-banner-contract.test.ts` requires of a
 * terminal "this section is unavailable" return — it says why in its own
 * words, and a `membership` view-only sentence above it would explain controls
 * that are not there.
 *
 * ## The invite defaults ON, deliberately
 *
 * `createAdminMember` gives a new member an unguessable random password hash,
 * so an administrator created WITHOUT an invite is an account nobody can sign
 * in to until somebody separately triggers a reset — which is not what the
 * operator on this step believes they just did. `sendInvite: true` is dispatched
 * by the create itself (verified: `createAdminMember` issues the action token,
 * writes the `PasswordResetToken` row and calls `sendMemberSetupInviteEmail`
 * inline; no follow-up `POST /api/admin/members/send-setup-invite` is needed),
 * and a send that fails comes back as a `warning` on an otherwise successful
 * 201 — the member exists and the step's count has moved, so that is surfaced
 * as a warning and never as a failure.
 */
export function SetupWizardFirstAdminPane() {
  const { data: session } = useSession();
  const canEdit = useAdminAreaEditAccess("membership");
  const viewOnlyReasonId = useId();
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [sendInvite, setSendInvite] = useState(true);
  const [saving, setSaving] = useState(false);

  const fullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  });

  const heading = (
    <div className="space-y-1">
      <h3 className="text-lg font-semibold text-foreground">
        Create an administrator
      </h3>
      <p className="text-sm text-muted-foreground">
        This step is satisfied by any active administrator account, which on a
        fresh install is the one the installer&rsquo;s seed created. Give a real
        person their own administrator account here so the club is not working
        from the shared seeded login. Creating one does not tick the step off —
        use &ldquo;Mark this step done&rdquo; above when you are happy with it,
        and manage existing members on Admin &rarr; Members.
      </p>
    </div>
  );

  if (session && !fullAdmin) {
    return (
      <section className="space-y-3 rounded-md border bg-card p-5">
        {heading}
        <p className="text-sm text-muted-foreground">
          Creating an administrator grants privileged access, which full
          administrators only may do. Ask a full administrator to create the
          account, or to give your own account full administrator access first.
        </p>
      </section>
    );
  }

  const viewOnlyBanner = (
    <div id={viewOnlyReasonId}>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        Membership view access can see this step. Membership edit access is
        required to create an administrator.
      </AdminViewOnlySectionBanner>
    </div>
  );

  const viewOnlyId = canEdit === false ? viewOnlyReasonId : undefined;

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          // The Full Admin token, and the reason the whole docblock above
          // exists: the readiness check counts the legacy `role` column, and
          // `createAdminMember` derives that column from these tokens. Remove
          // this line and the step never turns green.
          accessRoles: ["ADMIN"],
          // Not left to the service's default. That default is derived from the
          // age tier (`ageTier === "ADULT"`), and an administrator who cannot
          // log in is not an administrator — `normalizeAssignableAccessRoleTokens`
          // clears every token when `canLogin` is false, which would take the
          // access role above away with it.
          canLogin: true,
          sendInvite,
        }),
      });
      const body: { error?: string; warning?: string } | null = await response
        .json()
        .catch(() => null);
      if (!response.ok) {
        toast.error(body?.error ?? "Could not create the administrator.");
        return;
      }
      toast.success(
        sendInvite
          ? "Administrator created and the setup invite has been sent."
          : "Administrator created.",
      );
      // A 201 that still could not send the email. The member exists, so this
      // is not a failed create — but nobody is going to arrive in that inbox.
      if (body?.warning) toast.warning(body.warning);
      setEmail("");
      setFirstName("");
      setLastName("");
      // Only after the write succeeded: this is what makes the step's own
      // "N administrator accounts found." detail, its badge and the rail's
      // percentage re-read, since the operator never left the tab.
      emitSetupReadinessInputChanged();
    } catch {
      toast.error("Could not create the administrator.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3 rounded-md border bg-card p-5">
      {heading}
      {viewOnlyBanner}
      <form className="space-y-4" onSubmit={(event) => void create(event)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="first-admin-email">Email address</Label>
            <Input
              id="first-admin-email"
              type="email"
              required
              autoComplete="off"
              value={email}
              disabled={!canEdit}
              aria-describedby={viewOnlyId}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="first-admin-first-name">First name</Label>
            <Input
              id="first-admin-first-name"
              required
              value={firstName}
              disabled={!canEdit}
              aria-describedby={viewOnlyId}
              onChange={(event) => setFirstName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="first-admin-last-name">Last name</Label>
            <Input
              id="first-admin-last-name"
              required
              value={lastName}
              disabled={!canEdit}
              aria-describedby={viewOnlyId}
              onChange={(event) => setLastName(event.target.value)}
            />
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Checkbox
            id="first-admin-send-invite"
            className="mt-0.5"
            checked={sendInvite}
            disabled={!canEdit}
            aria-describedby={viewOnlyId}
            onCheckedChange={setSendInvite}
          />
          <Label
            htmlFor="first-admin-send-invite"
            className="text-sm font-normal"
          >
            Send an account setup invite ({MEMBER_SETUP_INVITE_TTL_DAYS}-day
            link). Without it the new account has no password anybody knows, so
            they cannot sign in until someone sends one.
          </Label>
        </div>
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={false}
          disabled={saving}
          type="submit"
        >
          {saving ? "Creating…" : "Create administrator"}
        </ViewOnlyActionButton>
      </form>
    </section>
  );
}
