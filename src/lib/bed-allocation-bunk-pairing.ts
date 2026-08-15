/**
 * Bunk-pairing validation for the room/bed inventory (#1675, extracted #2688).
 *
 * Its own module because it is its own rule with its own serialisation point:
 * the room-row lock below is one of this cluster's two `FOR UPDATE` sites, and
 * it exists solely to make the "at most two beds, one top and one bottom"
 * membership check safe against a concurrent writer.
 */
import type { BedType } from "@prisma/client";
import {
  BedAllocationAdminError,
  type BedAllocationDb,
} from "@/lib/bed-allocation-admin-contract";

// ---------------------------------------------------------------------------
// Bunk-pairing validation (#1675)
//
// A bunkGroup labels two physical beds stacked as a bunk: at most two beds may
// share one (roomId, bunkGroup), and they must be one BUNK_TOP + one
// BUNK_BOTTOM. A bunk type without a group is allowed (an unpaired bunk — the
// UI surfaces it as a soft warning); a group without a bunk type is rejected.
// These rules are enforced here rather than in the schema because a
// "<=2 per group, one of each type" invariant cannot be a plain unique index,
// and raw-SQL partial indexes are out of scope for this change.
// ---------------------------------------------------------------------------

function isBunkBedType(bedType: BedType): boolean {
  return bedType === "BUNK_TOP" || bedType === "BUNK_BOTTOM";
}

function bedTypeLabel(bedType: BedType): string {
  switch (bedType) {
    case "BUNK_TOP":
      return "bunk-top";
    case "BUNK_BOTTOM":
      return "bunk-bottom";
    case "DOUBLE":
      return "double";
    default:
      return "single";
  }
}

export function normalizeBunkGroup(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// Human list of quoted bed names, e.g. `"Old Top"` or `"Old Top" and "Old
// Bottom"`, used when naming the deactivated bed(s) that hold a bunk slot.
function quotedBedNames(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length <= 1) return quoted.join("");
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted[quoted.length - 1]}`;
}

export function assertBunkGroupTypeConsistency(
  bedType: BedType,
  bunkGroup: string | null,
) {
  if (bunkGroup && !isBunkBedType(bedType)) {
    throw new BedAllocationAdminError(
      "A bunk group needs a bunk-top or bunk-bottom bed type.",
      400,
    );
  }
}

// Serialise concurrent bunk-group writes for one room so two "add a bed to
// Bunk A" requests can't both pass the membership check and create an invalid
// three-bed (or two-top) group. The rule can't be a unique index and partial
// indexes are out of scope (#1675), so a row lock on the owning room is the
// serialisation point. Callers run this inside a transaction (self-wrapped when
// no client is supplied).
export async function lockRoomForBunkGroup(roomId: string, db: BedAllocationDb) {
  // `$executeRaw`, and the identifier quoted, both for the same reason (#2289):
  // the statement exists ONLY for its lock, so saying so in the call makes it
  // impossible to mistake for a read whose shape somebody might later trust.
  // `id` worked unquoted only because the column happens to be lowercase; every
  // other raw statement in this repository quotes, and an unquoted identifier
  // silently folds case the day a column is not.
  await db.$executeRaw`SELECT 1 FROM "LodgeRoom" WHERE "id" = ${roomId} FOR UPDATE`;
}

export async function assertBunkGroupCanAdmit(input: {
  roomId: string;
  bunkGroup: string;
  bedType: BedType;
  // The bed being updated is excluded so re-saving it never conflicts with
  // itself.
  excludeBedId?: string;
  db: BedAllocationDb;
}) {
  const others = await input.db.lodgeBed.findMany({
    where: {
      roomId: input.roomId,
      bunkGroup: input.bunkGroup,
      ...(input.excludeBedId ? { id: { not: input.excludeBedId } } : {}),
    },
    // name/active drive the deactivated-blocker steer: an inactive bed still
    // counts toward the group (membership semantics unchanged), so when it is
    // the reason a save is rejected the message names it and tells the admin to
    // reactivate or delete it — otherwise the slot looks mysteriously taken.
    select: { id: true, bedType: true, name: true, active: true },
  });

  if (others.length >= 2) {
    const deactivated = others.filter((bed) => bed.active === false);
    if (deactivated.length > 0) {
      // Reactivating or deleting a deactivated member only makes room for the
      // incoming bed when that member shares its type — it holds the very slot
      // the new bed wants. A deactivated opposite-type member can't be acted on
      // to admit a same-type bed, so name it but steer only to another group.
      const sameType = deactivated.filter(
        (bed) => bed.bedType === input.bedType,
      );
      if (sameType.length > 0) {
        const plural = sameType.length > 1;
        throw new BedAllocationAdminError(
          `Bunk group "${input.bunkGroup}" already has two beds, including the deactivated bed${
            plural ? "s" : ""
          } ${quotedBedNames(sameType.map((bed) => bed.name))}. Reactivate or delete ${
            plural ? "them" : "it"
          }, or use another group.`,
          409,
        );
      }
      const plural = deactivated.length > 1;
      throw new BedAllocationAdminError(
        `Bunk group "${input.bunkGroup}" already has two beds, including the deactivated bed${
          plural ? "s" : ""
        } ${quotedBedNames(deactivated.map((bed) => bed.name))}. Use another group.`,
        409,
      );
    }
    throw new BedAllocationAdminError(
      `Bunk group "${input.bunkGroup}" already has two beds. A bunk pairs one top and one bottom.`,
      409,
    );
  }

  const partner = others[0];
  if (partner && partner.bedType === input.bedType) {
    if (partner.active === false) {
      throw new BedAllocationAdminError(
        `Bunk group "${input.bunkGroup}" already has a ${bedTypeLabel(
          input.bedType,
        )} bed — the deactivated bed "${partner.name}". Reactivate or delete it, or use another group.`,
        409,
      );
    }
    throw new BedAllocationAdminError(
      `Bunk group "${input.bunkGroup}" already has a ${bedTypeLabel(
        input.bedType,
      )} bed. Pair a top with a bottom.`,
      409,
    );
  }
}
