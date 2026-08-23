import "server-only";

/**
 * What the environment-safety maintenance surface is TOLD (ENV-SAFETY 1, #3034;
 * epic #2986) — the payload `/api/admin/environment-safety` returns on both
 * verbs, and the readers that build it.
 *
 * It is a module rather than part of the route because `src/app` validates and
 * authorises at the boundary and delegates the rest to `src/lib`
 * (`docs/ARCHITECTURE.md` -> "Where code lives"), and because the route's own
 * 250-line budget is spent on the authorisation, confirmation, audit and
 * isolation reasoning that is genuinely about the WRITE. This half has one
 * question of its own: what may travel to a browser.
 *
 * `server-only` HERE and not on `environment-role.ts`, which is the split worth
 * understanding rather than copying blindly. The resolver has to stay importable
 * from the `tsx` `npm run setup` entrypoint (through `setup-readiness-db.ts`), so
 * it cannot carry `server-only`. This module has no such caller — it exists to
 * build a browser payload — so it takes the compiler-enforced guarantee, and the
 * panel that consumes the payload declares the same types itself rather than
 * importing them from here.
 *
 * WHAT IS DELIBERATELY NOT ON THE PAYLOAD: the changer's email (see
 * `MEMBER_NAME_SELECT`), the raw environment beyond the one refused value the
 * operator has to see to fix their own typo, and anything about the database
 * connection. This screen answers "which installation is this?" and nothing on
 * it needs a credential to do so.
 */

import {
  ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE,
  loadPersistedEnvironmentSafetySettings,
  type EnvironmentRole,
  type EnvironmentRoleDecidedBy,
  type EnvironmentRoleResolution,
  type PersistedEnvironmentSafetySettings,
} from "@/lib/environment-role";
import { prisma } from "@/lib/prisma";

/**
 * Name fields ONLY. The panel says WHO last changed the override, so it needs a
 * display name and nothing else — selecting the email, or the whole row, would
 * put a contact address into a configuration payload with no use for one.
 */
const MEMBER_NAME_SELECT = {
  firstName: true,
  lastName: true,
} as const;

/**
 * The flattened declaration. `raw` is non-null for exactly one state —
 * `invalid` — and it has already been stripped of control characters and capped
 * by `sanitizeEnvironmentRoleRawValue`, which is what makes it safe to render.
 * The panel has to NAME the refused value, because "that is not an accepted
 * value" is unactionable without saying what was read.
 */
export type EnvironmentSafetyDeclarationState = {
  kind: "production" | "non-production" | "absent" | "invalid";
  raw: string | null;
};

export type EnvironmentSafetyOverrideState = {
  /** Whether the safer override is forcing non-production right now. */
  on: boolean;
  /**
   * False when the row could not be read at all. Distinct from `on: false` on
   * purpose: "the override is off" and "we could not ask" have opposite safety
   * consequences, and the panel has to give different instructions for each.
   */
  readable: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
};

export type EnvironmentSafetyState = {
  role: EnvironmentRole;
  decidedBy: EnvironmentRoleDecidedBy;
  declaration: EnvironmentSafetyDeclarationState;
  override: EnvironmentSafetyOverrideState;
  /** The resolver's own operator-facing lines, rendered verbatim. */
  notes: string[];
};

/**
 * The display name of the member who last saved, or `null`. Defensive because
 * the column carries no foreign key (the house shape for a settings singleton),
 * so the member may since have been merged or deleted: a missing member, a blank
 * name and an unreachable database all mean "we cannot name them", never a
 * failed read of the setting.
 */
async function readChangedByName(
  memberId: string | null,
): Promise<string | null> {
  if (!memberId) return null;
  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: MEMBER_NAME_SELECT,
    });
    if (!member) return null;
    return `${member.firstName} ${member.lastName}`.trim() || null;
  } catch {
    return null;
  }
}

function declarationState(
  resolution: EnvironmentRoleResolution,
): EnvironmentSafetyDeclarationState {
  const { declaration } = resolution;
  return {
    kind: declaration.kind,
    raw: declaration.kind === "invalid" ? declaration.raw : null,
  };
}

async function overrideStateFromRow(
  row:
    | PersistedEnvironmentSafetySettings
    | null
    | typeof ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE,
): Promise<EnvironmentSafetyOverrideState> {
  if (row === ENVIRONMENT_SAFETY_SETTINGS_UNREADABLE) {
    return { on: false, readable: false, updatedAt: null, updatedByName: null };
  }
  if (!row) {
    return { on: false, readable: true, updatedAt: null, updatedByName: null };
  }
  return {
    on: row.forceNonProduction,
    readable: true,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: await readChangedByName(row.updatedByMemberId),
  };
}

/**
 * The state a READ produces.
 *
 * IT READS THE ROW A SECOND TIME, on purpose. `resolveEnvironmentRole()` exposes
 * `updatedAt` / `updatedByMemberId` only for an override that is ON, because that
 * is all the RESOLUTION needs — and widening its type so a settings screen could
 * show "switched off on 15 June by Ada" would put a display concern into the
 * module every safety decision in the platform goes through. One extra
 * primary-key read of a one-row table, on an administrator's page load, is the
 * cheaper side of that trade.
 */
export async function stateFromResolution(
  resolution: EnvironmentRoleResolution,
): Promise<EnvironmentSafetyState> {
  const row = await loadPersistedEnvironmentSafetySettings();
  return {
    role: resolution.role,
    decidedBy: resolution.decidedBy,
    declaration: declarationState(resolution),
    override: await overrideStateFromRow(row),
    notes: resolution.notes,
  };
}

/**
 * The state a WRITE produces: the resolution recomputed from the row this
 * request just wrote, rather than re-read from the database.
 *
 * Recomputing rather than re-reading is what makes the response describe the
 * write that just happened. A fresh `resolveEnvironmentRole()` here could pick
 * up a concurrent administrator's change and report it as this request's result.
 */
export async function stateFromWrittenRow(
  resolution: EnvironmentRoleResolution,
  row: PersistedEnvironmentSafetySettings,
): Promise<EnvironmentSafetyState> {
  return {
    role: resolution.role,
    decidedBy: resolution.decidedBy,
    declaration: declarationState(resolution),
    override: await overrideStateFromRow(row),
    notes: resolution.notes,
  };
}
