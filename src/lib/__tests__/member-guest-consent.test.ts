// "+ Add Member Guest" (epic #2305) MG1 (#2306) — the consent sub-state model.
//
// Five nullable columns are thirty-two shapes on paper. Only eight are legal,
// and which one a row is in decides real things: whether a bed is held, whether
// anyone was ever asked, and who the club can point at if the answer is
// questioned later. This file pins that table so MG2/MG3/MG4 each add a writer
// against a fixed contract instead of re-deriving one.
//
// It also pins the two discriminations that are easy to lose and expensive to
// lose:
//   * NULL is not CONFIRMED. "Nobody had to be asked" is a different fact from
//     "somebody said yes", and once they are conflated no later code can undo
//     it.
//   * A consent that was never SOLICITED (notify-only, or an admin placing the
//     guest) is not the same as one the target granted. requestedAt is the
//     discriminator, and respondedByMemberId separates the two unsolicited
//     cases from each other.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONSENT_FREE_GUEST_COLUMNS,
  MEMBER_GUEST_CONSENT_SUB_STATES,
  MEMBER_GUEST_WIDENING_ENABLED,
  classifyMemberGuestConsent,
  type MemberGuestConsentColumns,
} from "@/lib/member-guest-consent";
import { normalizeMemberGuestSettings } from "@/lib/member-guest-settings";
import {
  DEFAULT_MEMBER_GUEST_SETTINGS,
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
  MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
} from "@/config/club-settings-defaults";

// Test helper: reads a fixed repo file under process.cwd(); the path is
// test-controlled, not user input.
function readRepoFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

const TARGET = "m-target";
const DELEGATE = "m-delegate";
const ADMIN = "m-admin";
const T = new Date("2026-07-31T00:00:00.000Z");

function row(overrides: Partial<MemberGuestConsentColumns> = {}): MemberGuestConsentColumns {
  return { ...CONSENT_FREE_GUEST_COLUMNS, ...overrides };
}

describe("consent sub-state table", () => {
  it("declares exactly the eight reachable shapes, with unique ids", () => {
    const ids = MEMBER_GUEST_CONSENT_SUB_STATES.map((s) => s.id);
    expect(ids).toEqual([
      "FAMILY_OR_LEGACY",
      "AWAITING_TARGET",
      "TARGET_APPROVED",
      "DELEGATE_APPROVED",
      "NOTIFY_ONLY_AUTO_CONFIRMED",
      "ADMIN_ASSIGNED",
      "DECLINED",
      "EXPIRED",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks exactly one shape as reachable in this release", () => {
    // The dark guarantee, expressed as data: a member-guest row created by MG1
    // is consent-FREE, and every other shape needs code MG1 does not ship.
    const reachable = MEMBER_GUEST_CONSENT_SUB_STATES.filter((s) => s.reachableInMg1);
    expect(reachable.map((s) => s.id)).toEqual(["FAMILY_OR_LEGACY"]);
    expect(MEMBER_GUEST_WIDENING_ENABLED).toBe(false);
  });

  it("gives every shape a written note", () => {
    for (const state of MEMBER_GUEST_CONSENT_SUB_STATES) {
      expect(state.note.length).toBeGreaterThan(20);
    }
  });

  it("keeps the two never-solicited shapes distinguishable", () => {
    // The amendment that made this table binding turns on exactly this pair.
    const notifyOnly = MEMBER_GUEST_CONSENT_SUB_STATES.find(
      (s) => s.id === "NOTIFY_ONLY_AUTO_CONFIRMED",
    )!;
    const adminAssigned = MEMBER_GUEST_CONSENT_SUB_STATES.find(
      (s) => s.id === "ADMIN_ASSIGNED",
    )!;

    // Both are CONFIRMED with no request...
    expect(notifyOnly.status).toBe("CONFIRMED");
    expect(adminAssigned.status).toBe("CONFIRMED");
    expect(notifyOnly.requestedAt).toBe("null");
    expect(adminAssigned.requestedAt).toBe("null");

    // ...and the responder is what tells them apart. Auto-confirm has nobody to
    // name; an admin assignment names the admin, which is how MG4's audit works
    // without a new column.
    expect(notifyOnly.respondedAt).toBe("null");
    expect(notifyOnly.respondedBy).toBe("null");
    expect(adminAssigned.respondedAt).toBe("set");
    expect(adminAssigned.respondedBy).toBe("admin");

    // Neither is waiting for an answer, so neither carries a hold deadline.
    // The classifier enforces this; without it, "CONFIRMED with an expiry"
    // would classify happily and MG2's sweep would meet a settled row that
    // looks like a live hold.
    expect(notifyOnly.expiresAt).toBe("null");
    expect(adminAssigned.expiresAt).toBe("null");
  });

  it("requires a decline to name who refused", () => {
    // Declining is an attributed act: MG4's audit reads respondedBy to say who
    // turned the add down, so "any" would let an unattributed refusal through.
    const declined = MEMBER_GUEST_CONSENT_SUB_STATES.find((s) => s.id === "DECLINED")!;
    expect(declined.respondedBy).toBe("set");
  });
});

describe("classifyMemberGuestConsent", () => {
  it("classifies a family-scope or legacy row", () => {
    expect(classifyMemberGuestConsent(row(), TARGET)).toBe("FAMILY_OR_LEGACY");
    expect(classifyMemberGuestConsent(row(), null)).toBe("FAMILY_OR_LEGACY");
  });

  it("classifies a pending hold", () => {
    expect(
      classifyMemberGuestConsent(
        row({ consentStatus: "PENDING", consentRequestedAt: T, consentExpiresAt: T }),
        TARGET,
      ),
    ).toBe("AWAITING_TARGET");
  });

  it("separates a target approval from a delegate approval by the responder", () => {
    const base = {
      consentStatus: "CONFIRMED" as const,
      consentRequestedAt: T,
      consentRespondedAt: T,
    };
    expect(
      classifyMemberGuestConsent(row({ ...base, consentRespondedByMemberId: TARGET }), TARGET),
    ).toBe("TARGET_APPROVED");
    expect(
      classifyMemberGuestConsent(row({ ...base, consentRespondedByMemberId: DELEGATE }), TARGET),
    ).toBe("DELEGATE_APPROVED");
  });

  it("classifies a notify-only auto-confirm", () => {
    // CONFIRMED with nothing else set. This is the shape the coherence review
    // made binding, and it is deliberately NOT written as all-nulls: the guest
    // IS cross-family, and that has to stay visible.
    const auto = row({ consentStatus: "CONFIRMED" });
    expect(classifyMemberGuestConsent(auto, TARGET)).toBe("NOTIFY_ONLY_AUTO_CONFIRMED");
    expect(classifyMemberGuestConsent(auto, TARGET)).not.toBe("FAMILY_OR_LEGACY");
  });

  it("classifies an admin-assigned or copied row", () => {
    expect(
      classifyMemberGuestConsent(
        row({
          consentStatus: "CONFIRMED",
          consentRespondedAt: T,
          consentRespondedByMemberId: ADMIN,
        }),
        TARGET,
      ),
    ).toBe("ADMIN_ASSIGNED");
  });

  it("classifies a decline and an expiry, and keeps them apart", () => {
    expect(
      classifyMemberGuestConsent(
        row({
          consentStatus: "DECLINED",
          consentRequestedAt: T,
          consentRespondedAt: T,
          consentRespondedByMemberId: TARGET,
        }),
        TARGET,
      ),
    ).toBe("DECLINED");

    // Nobody refused; the clock ran out. No responder, by definition.
    expect(
      classifyMemberGuestConsent(
        row({ consentStatus: "EXPIRED", consentRequestedAt: T, consentExpiresAt: T }),
        TARGET,
      ),
    ).toBe("EXPIRED");
  });

  it("refuses to classify combinations the model does not define", () => {
    // The useful failure. A writer that invents a shape gets null here rather
    // than being quietly filed under the nearest legal one.
    const illegal: Array<[string, MemberGuestConsentColumns]> = [
      ["null status carrying a request", row({ consentRequestedAt: T })],
      ["null status carrying a responder", row({ consentRespondedByMemberId: ADMIN })],
      ["pending with no expiry (an unbounded bed hold)", row({ consentStatus: "PENDING", consentRequestedAt: T })],
      ["pending that has already been answered", row({ consentStatus: "PENDING", consentRequestedAt: T, consentExpiresAt: T, consentRespondedAt: T })],
      ["solicited confirm with nobody recorded as answering", row({ consentStatus: "CONFIRMED", consentRequestedAt: T, consentRespondedAt: T })],
      ["expired that names a responder", row({ consentStatus: "EXPIRED", consentRequestedAt: T, consentExpiresAt: T, consentRespondedByMemberId: TARGET })],
      ["decline that was never requested", row({ consentStatus: "DECLINED", consentRespondedAt: T })],
      // A refusal is an attributed act — MG4's audit rides respondedBy.
      ["decline with nobody recorded as refusing", row({ consentStatus: "DECLINED", consentRequestedAt: T, consentRespondedAt: T })],
      // Both never-solicited shapes say expiresAt: "null" in the table. A
      // settled row carrying a live hold deadline is a broken row, not a
      // variant — MG2's sweep reads expiresAt and must never meet one.
      ["notify-only auto-confirm carrying a hold expiry", row({ consentStatus: "CONFIRMED", consentExpiresAt: T })],
      [
        "admin assignment carrying a hold expiry",
        row({
          consentStatus: "CONFIRMED",
          consentRespondedAt: T,
          consentRespondedByMemberId: ADMIN,
          consentExpiresAt: T,
        }),
      ],
    ];
    for (const [label, columns] of illegal) {
      expect(classifyMemberGuestConsent(columns, TARGET), label).toBeNull();
    }
  });

  it("keeps NULL and CONFIRMED as different answers", () => {
    // Said once more on its own, because it is the invariant most likely to be
    // "simplified" away by a later writer looking for one boolean.
    expect(classifyMemberGuestConsent(row(), TARGET)).toBe("FAMILY_OR_LEGACY");
    expect(classifyMemberGuestConsent(row({ consentStatus: "CONFIRMED" }), TARGET)).toBe(
      "NOTIFY_ONLY_AUTO_CONFIRMED",
    );
  });
});

// ---------------------------------------------------------------------------
// The two mirrors, GENERATED rather than eyeballed
// ---------------------------------------------------------------------------
// Asserting only that each sub-state ID appears somewhere in the docs proved
// nothing: a planted mutant that swapped a doc row's columns (or left a row
// stale after the code changed) passed happily, because the LABEL was still
// there. So each mirror line is now generated from the code table through the
// one mapping below and asserted verbatim. A shape that changes in code and not
// in the mirror fails here.
type SubState = (typeof MEMBER_GUEST_CONSENT_SUB_STATES)[number];

/** The vocabulary the table may use for a column's nullness. */
const NULLNESS_WORDS = ["set", "null", "any"] as const;

/** How each `respondedBy` word is spelled in the DOMAIN_INVARIANTS table. */
const RESPONDER_DOC_WORDS: Record<string, string> = {
  null: "null",
  set: "set",
  any: "any",
  target: "the guest themselves",
  other: "someone other than the guest",
  admin: "the acting admin",
};

function statusWord(state: SubState): string {
  return state.status === null ? "NULL" : state.status;
}

/** One row of the eight-row table in docs/DOMAIN_INVARIANTS.md. */
function docTableRow(state: SubState): string {
  const status = state.status === null ? "`NULL`" : `\`${state.status}\``;
  return [
    "",
    `\`${state.id}\``,
    status,
    state.requestedAt,
    state.respondedAt,
    RESPONDER_DOC_WORDS[state.respondedBy],
    state.expiresAt,
    "",
  ].join(" | ").trim();
}

/** One summary line of the `BookingGuest` schema comment. */
function schemaSummaryLine(state: SubState): string {
  return (
    `${state.id}: status ${statusWord(state)}` +
    ` / requestedAt ${state.requestedAt}` +
    ` / respondedAt ${state.respondedAt}` +
    ` / respondedBy ${state.respondedBy}` +
    ` / expiresAt ${state.expiresAt}`
  );
}

describe("the documented model matches the shipped one", () => {
  it("uses only the declared vocabulary for every column", () => {
    // The generators below are only meaningful while every word they translate
    // is one they know about.
    for (const state of MEMBER_GUEST_CONSENT_SUB_STATES) {
      expect(NULLNESS_WORDS, state.id).toContain(state.requestedAt);
      expect(NULLNESS_WORDS, state.id).toContain(state.respondedAt);
      expect(NULLNESS_WORDS, state.id).toContain(state.expiresAt);
      expect(
        Object.keys(RESPONDER_DOC_WORDS),
        `${state.id}: no doc spelling for respondedBy "${state.respondedBy}"`,
      ).toContain(state.respondedBy);
    }
  });

  it("is mirrored row-for-row in docs/DOMAIN_INVARIANTS.md", () => {
    const invariants = readRepoFile("docs/DOMAIN_INVARIANTS.md");
    for (const state of MEMBER_GUEST_CONSENT_SUB_STATES) {
      expect(
        invariants,
        `${state.id}: DOMAIN_INVARIANTS is missing or stale for\n  ${docTableRow(state)}`,
      ).toContain(docTableRow(state));
    }
  });

  it("is mirrored line-for-line on the BookingGuest schema block", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    expect(schema).toContain("MEMBER_GUEST_CONSENT_SUB_STATES");
    for (const state of MEMBER_GUEST_CONSENT_SUB_STATES) {
      expect(
        schema,
        `${state.id}: schema.prisma is missing or stale for\n  ${schemaSummaryLine(state)}`,
      ).toContain(schemaSummaryLine(state));
      // ...and every label the table names is a registered enum value.
      if (state.status !== null) {
        expect(schema).toMatch(new RegExp(`^\\s+${state.status}$`, "m"));
      }
    }
  });

  it("documents the states as unreachable until MG2 in STATE_MACHINES.md", () => {
    const stateMachines = readRepoFile("docs/STATE_MACHINES.md");
    expect(stateMachines).toContain("MemberGuestConsentStatus");
    expect(stateMachines).toMatch(/unreachable/i);
  });
});

describe("member-guest policy singleton", () => {
  it("synthesises the shipped defaults when the row has never been saved", () => {
    // Lazy creation (D.19): a club that has never opened the settings reads
    // approval-required, a 7-day hold, and both privacy toggles off — and
    // nothing is written to get that answer.
    expect(normalizeMemberGuestSettings(null)).toEqual({
      approvalRequired: true,
      pendingHoldExpiryDays: 7,
      openMemberSearchEnabled: false,
      openMemberSearchIncludesMinors: false,
    });
    expect(normalizeMemberGuestSettings(undefined)).toEqual(DEFAULT_MEMBER_GUEST_SETTINGS);
  });

  it("fills only the columns a partial row is missing", () => {
    expect(
      normalizeMemberGuestSettings({ approvalRequired: false, pendingHoldExpiryDays: 3 }),
    ).toEqual({
      approvalRequired: false,
      pendingHoldExpiryDays: 3,
      openMemberSearchEnabled: false,
      openMemberSearchIncludesMinors: false,
    });
  });

  it("matches the schema column defaults", () => {
    // The defaults constant and the schema are two places one value has to
    // agree, and only one of them is what a fresh INSERT gets.
    const schema = readRepoFile("prisma/schema.prisma");
    expect(schema).toMatch(/approvalRequired\s+Boolean\s+@default\(true\)/);
    expect(schema).toMatch(/pendingHoldExpiryDays\s+Int\s+@default\(7\)/);
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.approvalRequired).toBe(true);
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.pendingHoldExpiryDays).toBe(7);
  });

  it("carries the 1..60 expiry bounds the owner confirmed", () => {
    expect(MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN).toBe(1);
    expect(MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX).toBe(60);
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.pendingHoldExpiryDays).toBeGreaterThanOrEqual(
      MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MIN,
    );
    expect(DEFAULT_MEMBER_GUEST_SETTINGS.pendingHoldExpiryDays).toBeLessThanOrEqual(
      MEMBER_GUEST_PENDING_HOLD_EXPIRY_DAYS_MAX,
    );
  });
});

describe("member-merge classification", () => {
  it("documents both new FK-less member-id scalars", () => {
    // The list is explicitly illustrative, so nothing fails if a column is
    // omitted — which is exactly why it is asserted here.
    const memberMerge = readRepoFile("src/lib/member-merge.ts");
    expect(memberMerge).toContain('"BookingGuest.consentRespondedByMemberId"');
    expect(memberMerge).toContain('"MemberGuestSettings.updatedByMemberId"');
  });

  it("adds no Member relation, so the DMMF completeness walk is untouched", () => {
    // Keeping consentRespondedByMemberId FK-less is what keeps this migration
    // off a validating constraint on the hot BookingGuest table — and it also
    // means MEMBER_MERGE_RELATION_SPECS needs no new row.
    const schema = readRepoFile("prisma/schema.prisma");
    const model = schema.slice(
      schema.indexOf("model BookingGuest {"),
      schema.indexOf("enum MemberGuestConsentStatus"),
    );
    expect(model).toContain("consentRespondedByMemberId String?");
    expect(model).not.toMatch(/consentRespondedByMemberId.*@relation/);
  });
});

describe("migrations", () => {
  const MIGRATIONS = [
    "prisma/migrations/20260731120000_add_member_guests_module_and_settings/migration.sql",
    "prisma/migrations/20260731120100_add_booking_guest_consent/migration.sql",
  ];

  it("writes no data at all", () => {
    // No seed row, no backfill, and therefore nothing for the session-clock DML
    // gate to catch. The singleton is created lazily on first write instead.
    for (const file of MIGRATIONS) {
      const sql = readRepoFile(file)
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
      expect(sql, file).not.toMatch(/\bINSERT\b/i);
      expect(sql, file).not.toMatch(/\bUPDATE\b/i);
    }
  });

  it("adds the consent columns nullable, default-free, and without a foreign key", () => {
    // Every clause of that sentence is a lock the migration does not take on a
    // hot table: no default means no rewrite, no FK means no validation scan.
    const sql = readRepoFile(MIGRATIONS[1]);
    expect(sql).toContain('ALTER TABLE "BookingGuest" ADD COLUMN');
    expect(sql).not.toMatch(/ADD COLUMN[^;]*NOT NULL/i);
    expect(sql).not.toMatch(/ADD CONSTRAINT/i);
    expect(sql).not.toMatch(/REFERENCES/i);
  });

  it("uses a label only where the type it belongs to was just CREATEd", () => {
    // The honest version of what used to be asserted here. The index predicate
    // DOES name 'PENDING', so "registers the labels and never uses one" was
    // false — and the old assertion only passed because it exempted
    // CREATE INDEX, i.e. it exempted the single line that could have failed it.
    //
    // The real rationale is narrower and still holds: PostgreSQL refuses to use
    // a label added by ALTER TYPE ... ADD VALUE in the same transaction, but a
    // type created by CREATE TYPE in that transaction is usable straight away.
    // So what matters is that this migration CREATEs the type (it is brand new)
    // rather than ALTERing an existing one, and that the CREATE precedes the use.
    const sql = readRepoFile(MIGRATIONS[1]);
    const statements = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith("--"));

    expect(sql).toContain('CREATE TYPE "MemberGuestConsentStatus"');
    expect(sql, "an ALTER TYPE ADD VALUE label could not be used in this transaction")
      .not.toMatch(/ALTER TYPE/i);

    // Exactly one statement names a label, and it is the index predicate.
    const labelUses = statements.filter(
      (line) => /'PENDING'/.test(line) && !/^CREATE TYPE/.test(line.trim()),
    );
    expect(labelUses).toHaveLength(1);
    expect(labelUses[0]).toContain(
      'CREATE INDEX "BookingGuest_pendingConsent_expiresAt_idx"',
    );
    expect(sql.indexOf("CREATE TYPE")).toBeLessThan(sql.indexOf(labelUses[0]));

    // And no DML, so no row ever carries a label in this migration — which is
    // what keeps the REVERSE blue/green direction safe (an old-colour client
    // can never read a value it cannot deserialise).
    expect(statements.join("\n")).not.toMatch(/\bINSERT\b|\bUPDATE\b/i);
  });

  it("records the partial index in the manifest Prisma cannot see", () => {
    const sql = readRepoFile(MIGRATIONS[1]);
    expect(sql).toContain('CREATE INDEX "BookingGuest_pendingConsent_expiresAt_idx"');
    const manifest = readRepoFile("prisma/partial-unique-indexes.tsv");
    expect(manifest).toContain("BookingGuest_pendingConsent_expiresAt_idx");
    expect(manifest).toContain("WHERE (\"consentStatus\" = 'PENDING'::\"MemberGuestConsentStatus\")");
  });

  it("has a blue/green ledger row for each, and a lock-impact plan on the hot one", () => {
    const ledger = readRepoFile("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith("#"));
    const rows = MIGRATIONS.map((file) => {
      const name = file.split("/")[2];
      const row = ledger.find((line) => line.startsWith(`${name}\t`));
      expect(row, `no ledger row for ${name}`).toBeDefined();
      return row!.split("\t");
    });

    for (const [, phase, , oldCodeCompatible] of rows) {
      expect(phase).toBe("expand");
      expect(oldCodeCompatible).toBe("yes");
    }
    // The hot-table row has to argue BOTH blue/green directions; the reverse
    // one is only true because this release is dark.
    const hotPlan = rows[1][4];
    expect(hotPlan.length).toBeGreaterThan(1000);
    expect(hotPlan).toContain("HOT_TABLE_SQL_REGEX");
    expect(hotPlan).toContain("MEMBER_GUEST_WIDENING_ENABLED");
  });
});
