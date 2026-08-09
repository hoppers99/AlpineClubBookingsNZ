/**
 * The audit-writer census CONTRACT (#2581).
 *
 * WHAT THIS GATE IS FOR. `AuditLog.category` is the only field a
 * category-filtered reader can filter on, so a row written without one is a row
 * the AI Diagnostics correlation tools return to nobody — `category = ANY ($1)`
 * evaluates to NULL, not true. #2581 found 82 production write sites in that
 * state and no way to notice the 83rd. This file is the way to notice it: the
 * census below is measured from the TypeScript AST on every run and compared
 * against the reviewed manifest, so a new uncategorised audit writer fails CI
 * with its own symbol in the message.
 *
 * IT ALSO CLOSES THE THREE HOLES THAT MADE THE HAND CENSUS UNRELIABLE:
 *
 *  - a category value the taxonomy does not contain (three writers had invented
 *    `membership`, one had invented `auth`, and nothing rejected either);
 *  - a hand-written `auditLog.create` that bypasses the audit boundary and so
 *    gets no sanitisation and no retention derivation;
 *  - a wrapper that stops passing a category, taking every caller with it.
 *
 * WHY IT PINS EXACT SETS RATHER THAN CEILINGS. A "no more than 82" assertion
 * passes when one writer is fixed and another is added. The uncategorised
 * population is pinned as a SET keyed by stable symbol, so fixing a writer means
 * deleting its manifest entry in the same diff, and adding one means adding an
 * entry a reviewer will see.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_CORRELATION_DOMAIN,
  AUDIT_CATEGORY_LABELS,
  auditCategoryReaderAreas,
  isAuditCategory,
} from "@/lib/audit-categories";
import { MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS } from "@/lib/audit-query";

import {
  describeCategory,
  scanAuditWriterCensus,
  type AuditWriteSite,
} from "../../../scripts/audit/audit-writer-census";
import {
  APPLIED_AUDIT_CATEGORIES,
  APPROVED_FORWARDED_CATEGORY_SITES,
  APPROVED_MIGRATION_AUDIT_SQL,
  APPROVED_NON_PRODUCING_AUDIT_DML,
  AUDIT_CENSUS_TOTALS,
  AUDIT_WRITER_WRAPPERS,
  AUDIT_WRITERS_WITHOUT_ENTITY_IDENTIFIER,
  UNCATEGORISED_AUDIT_WRITERS,
} from "../../../scripts/audit/audit-writer-census-manifest";

/**
 * One scan for the whole file. Parsing `src/`, `scripts/` and `prisma/` costs
 * several seconds and nine assertions ask questions of the same result.
 */
let cached: ReturnType<typeof scanAuditWriterCensus> | null = null;
function census() {
  cached ??= scanAuditWriterCensus();
  return cached;
}

function ids(sites: readonly AuditWriteSite[]): string[] {
  return sites.map((site) => site.id).sort();
}

type CurrentCensusClaim = {
  file: string;
  writeSites: number;
  uncategorised: number;
};

function currentAuditCensusClaims(): CurrentCensusClaim[] {
  const repoRoot = process.cwd();
  const sourceFiles: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(path);
      } else if (entry.name.endsWith(".md") || entry.name.endsWith(".ts")) {
        sourceFiles.push(path);
      }
    }
  };
  walk(resolve(repoRoot, "docs"));
  walk(resolve(repoRoot, "src", "lib", "diagnostics", "tools", "packs"));

  const patterns: readonly {
    pattern: RegExp;
    implicitUncategorised?: number;
  }[] = [
    {
      pattern:
        /\b(?<writeSites>\d+)\s+row-producing\s+production\s+audit\s+write\s+sites\b[^.]{0,120}?\b(?<uncategorised>zero|\d+)\b[^.]{0,50}\b(?:record no category|uncategorised)\b/giu,
    },
    {
      pattern:
        /\b(?:the\s+)?census(?:\s+now)?\s+reads\s+(?<writeSites>\d+)\s+(?:row-producing\s+)?(?:production\s+)?(?:audit\s+)?write\s+sites\s+and\s+(?<uncategorised>zero|\d+)\s+uncategorised\b/giu,
    },
    {
      pattern:
        /\bcurrent\s+exact-head\s+production\s+writers\s+have\s+(?<writeSites>\d+)\s+row-producing\s+sites\s+and\s+(?<uncategorised>zero|\d+)\s+uncategorised\s+sites\b/giu,
    },
    {
      pattern:
        /\b(?:the\s+)?exact-head\s+census\s+has\s+(?<writeSites>\d+)\s+row-producing\s+current\s+production\s+writer\s+sites\s+and\s+(?<uncategorised>zero|\d+)\s+uncategorised\s+sites\b/giu,
    },
    {
      pattern: /\ball\s+(?<writeSites>\d+)\s+now\s+record\s+a\s+category\b/giu,
      implicitUncategorised: 0,
    },
  ];

  const claims: CurrentCensusClaim[] = [];
  for (const sourceFile of sourceFiles) {
    const contents = readFileSync(sourceFile, "utf8")
      .replaceAll("**", "")
      .replace(/\s+\*\s+/g, " ")
      .replace(/\s+/g, " ");
    for (const { pattern, implicitUncategorised } of patterns) {
      for (const match of contents.matchAll(pattern)) {
        const groups = match.groups ?? {};
        const uncategorised = groups.uncategorised;
        claims.push({
          file: relative(repoRoot, sourceFile).replaceAll("\\", "/"),
          writeSites: Number(groups.writeSites),
          uncategorised:
            implicitUncategorised ??
            (uncategorised?.toLowerCase() === "zero"
              ? 0
              : Number(uncategorised)),
        });
      }
    }
  }
  return claims.sort((left, right) => left.file.localeCompare(right.file));
}

describe("audit writer census (#2581)", { timeout: 180_000 }, () => {
  it("actually scanned the tree, so a broken walk cannot pass as a clean census", () => {
    // The failure mode this catches is the worst one available: a path change or a
    // bad exclusion makes `listSourceFiles` return nothing, every "no offenders"
    // assertion below passes vacuously, and the gate reports success while
    // measuring an empty tree.
    expect(census().filesScanned).toBeGreaterThan(1_500);
    expect(census().sites.length).toBeGreaterThan(300);
  });

  it("finds exactly the pinned number of production audit write sites", () => {
    expect(
      census().sites.length,
      "The number of production audit write sites moved. That is fine — it moves " +
        "whenever a feature records something new — but it is not a silent change: " +
        "update AUDIT_CENSUS_TOTALS.writeSites, and check the new writer appears " +
        "with a category rather than in UNCATEGORISED_AUDIT_WRITERS.",
    ).toBe(AUDIT_CENSUS_TOTALS.writeSites);
  });

  it("finds exactly the pinned per-sink split", () => {
    // Per-sink as well as in total, because a writer moved from `logAudit` to a
    // hand-built `auditLog.create` leaves the total untouched while losing the
    // boundary's sanitisation and retention derivation.
    const measured = Object.fromEntries(
      Object.entries(census().sinkCounts).map(([sink, counts]) => [
        sink,
        { total: counts.total, uncategorised: counts.uncategorised },
      ]),
    );
    expect(measured).toEqual(AUDIT_CENSUS_TOTALS.bySink);
  });

  it("has exactly the reviewed set of UNCATEGORISED writers, and no others", () => {
    /*
      The gate, and as of #2581's second child the pinned set is EMPTY: all 82
      writers child 1 found have been classified at the source.

      That makes this assertion stricter than it was, not weaker. A set-equality
      pin against an empty manifest means the FIRST new uncategorised writer
      fails CI by name — there is no backlog left for it to hide in, and nobody
      can re-open one by adding an entry here instead of a category at the site.
    */
    expect(
      ids(census().uncategorised),
      "An audit write site records no category. A row with no category is " +
        "returned by NO Diagnostics correlation tool, and — because " +
        "buildAuditLogCreateData derives retention only when a category, severity " +
        "or retention class is present — it is also written with no expiry and " +
        "kept forever. Pass a canonical category from @/lib/audit-categories at " +
        "the site, or, if it genuinely belongs to the #2581 backlog, add it to " +
        "UNCATEGORISED_AUDIT_WRITERS with the category you propose for it.",
    ).toEqual(Object.keys(UNCATEGORISED_AUDIT_WRITERS).sort());
  });

  it("discovers and pins every runtime or document current-census claim", () => {
    /*
      Current totals occur in operator docs, model-facing runtime scope, and a
      runtime source contract. The old hand-maintained four-document list missed
      the second booking-guide occurrence and both runtime occurrences. Discover
      the reviewed wording instead, pin the occurrence inventory, and compare every
      value with the manifest.

      Changing a number, deleting/rewording a claim so it escapes the parser, or
      adding a new current-fact copy all fail visibly. Historical statements such
      as "82 were still uncategorised when #2581 opened" deliberately do not match:
      they remain true and are not current-fact copies.
    */
    const totals = AUDIT_CENSUS_TOTALS;
    const claims = currentAuditCensusClaims();
    expect(
      claims.map((claim) => claim.file),
      "The inventory of runtime/docs current audit-census claims changed. Keep " +
        "the wording recognisable, and review every new or removed copy here.",
    ).toEqual([
      "docs/ai-diagnostics/tool-pack-booking-membership.md",
      "docs/ai-diagnostics/tool-pack-booking-membership.md",
      "docs/ai-diagnostics/tool-pack-finance.md",
      "docs/ai-diagnostics/tool-pack-support.md",
      "docs/guides/audit-log.md",
      "src/lib/diagnostics/tools/packs/booking-records.ts",
      "src/lib/diagnostics/tools/packs/support-correlation.ts",
    ]);
    expect(
      claims,
      "A runtime or document current-fact copy is stale. Re-run `npm run " +
        "audit:census`, then update every discovered claim in the same commit.",
    ).toEqual(
      claims.map(({ file }) => ({
        file,
        writeSites: totals.writeSites,
        uncategorised: totals.uncategorised,
      })),
    );
  });

  it("keeps every classification #2581 applied exactly where it was reviewed", () => {
    /*
      The SWAP gate, and the reason this exists on top of `categoryValues`.

      A distribution pin catches a category gaining or losing sites. It does not
      catch a swap: move one writer from `booking` to `payment` and another the
      other way, and every count is identical while BOTH rows changed who can
      read them — `booking` needs `bookings:view`, `payment` needs
      `finance:view`. This pins the per-site answer, so any single
      reclassification among the 83 sites child 2 touched is a named diff.
    */
    const measured = Object.fromEntries(
      census()
        .sites.filter((site) => site.id in APPLIED_AUDIT_CATEGORIES)
        .map((site) => [site.id, describeCategory(site.category)]),
    );

    expect(
      measured,
      "A writer classified by #2581 now records a different category, or has " +
        "moved and taken its identity with it. Category decides which admin " +
        "areas a Diagnostics reader must hold AND whether a member sees the row " +
        "in their own timeline, so this is a readership change: update " +
        "APPLIED_AUDIT_CATEGORIES and say what moved in the changelog.",
    ).toEqual(APPLIED_AUDIT_CATEGORIES);
  });

  it("pins which classified writers a MEMBER can now see about themselves", () => {
    /*
      The member-facing half of the same question, stated as a number rather than
      left to be inferred from the table above.

      The member self-timeline filters on category (`buildMemberVisibleAuditLogWhere`),
      so classifying a previously null-category writer INTO a member-visible
      category can publish it on a member-facing surface. Of the 83 sites child 2
      classified, the ones landing in `lodge` and `xero` are the ones members
      never see; everything else is member-visible. Both halves are pinned, so
      moving a writer ACROSS the boundary in either direction fails here with the
      direction named.

      What made the 56 safe to publish, checked per family rather than assumed:
      every one of those rows is about the member who can now see it or about a
      club-wide rule they are subject to, the member projection returns no
      metadata, no request id, no IP and no drill-downs, and each row's `details`
      is either a JSON object (which the member projection suppresses entirely)
      or a sentence the member already knows.
    */
    // MEASURED from the tree, not read back out of the manifest, deliberately.
    // A pin that reads its own table only bites when somebody edits the table;
    // this one bites when somebody edits a ROUTE, which is where the crossing
    // actually happens.
    const memberVisible = new Set<string>(
      MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS.map((option) => option.value),
    );
    const classified = census()
      .sites.filter((site) => site.id in APPLIED_AUDIT_CATEGORIES)
      .map((site) => describeCategory(site.category));
    const visible = classified.filter((category) => memberVisible.has(category));
    const hidden = classified.filter((category) => !memberVisible.has(category));

    expect(
      visible.length,
      "A writer #2581 classified crossed the MEMBER SELF-TIMELINE boundary. " +
        "That publishes an event on a member-facing surface, or withdraws one " +
        "from it — never a side effect of a refactor. Say which way it moved and " +
        "why the row is safe for the member it is about.",
    ).toBe(56);
    expect([...new Set(hidden)].sort()).toEqual(["lodge", "xero"]);
    expect(hidden).toHaveLength(27);
  });

  it("names every classified writer that still carries NO entity identifier", () => {
    /*
      Child 1 measured that only 9 of the 82 passed an `entityType` or `entityId`,
      which is the "missing entity identifiers that prevent bounded correlation"
      case the owner named as in-scope. Child 2 added them at 67 of the 83.

      The remaining 16 are pinned by NAME rather than by a count, because the
      tempting wrong answer is available at every one of them: the acting
      administrator's member id is always in scope, and writing it as the entity
      would put a false reference into the club's audit trail that reads as
      correlation. Each entry records why the site genuinely has no record to
      name.
    */
    const missing = census()
      .sites.filter(
        (site) => site.id in APPLIED_AUDIT_CATEGORIES && !site.hasEntityIdentifier,
      )
      .map((site) => site.id)
      .sort();

    expect(
      missing,
      "A writer classified by #2581 carries no entityType or entityId, so a " +
        "categorised row from it still cannot be correlated to a record. Add " +
        "the identifier at the site, or — if the event genuinely affects a " +
        "collection rather than a row — record why in " +
        "AUDIT_WRITERS_WITHOUT_ENTITY_IDENTIFIER.",
    ).toEqual(Object.keys(AUDIT_WRITERS_WITHOUT_ENTITY_IDENTIFIER).sort());
  });

  it("pins the uncategorised count the issue and the docs quote", () => {
    // The same number reaches three prose surfaces — this issue, the Diagnostics
    // docblock and docs/ai-diagnostics/tool-pack-support.md — and all three have
    // already carried a stale one (81 of ~350). Pinning it here is what makes them
    // fixable in lockstep.
    expect(census().uncategorised.length).toBe(AUDIT_CENSUS_TOTALS.uncategorised);
    expect(Object.keys(UNCATEGORISED_AUDIT_WRITERS)).toHaveLength(
      AUDIT_CENSUS_TOTALS.uncategorised,
    );
  });

  it("writes only CANONICAL category values", () => {
    /*
      The invented-value gate. Before #2581 the writer type ended in
      `| (string & {})`, so `category: "membership"` (three nomination writers) and
      `category: "auth"` (the auth-bounce writer) both compiled and both produced
      rows that no Admin filter and no correlation tool could select. The closed
      type is the primary defence; this is the one that still works if someone
      widens the type again, or writes the value through a cast.
    */
    const offenders = census()
      .sites.filter(
        (site) => site.category.kind === "literal" && !isAuditCategory(site.category.value),
      )
      .map((site) => `${site.id} → ${describeCategory(site.category)}`);

    expect(
      offenders,
      "An audit writer passes a category that is not in AUDIT_CATEGORIES. Rows " +
        "written with an unknown value are selectable by no reader. Either use a " +
        "canonical value, or add the new one to audit-categories.ts — which also " +
        "requires giving it a badge colour and a correlation domain.",
    ).toEqual([]);
  });

  it("pins how many sites write each category, so a reclassification is visible", () => {
    expect(
      census().categoryCounts,
      "The distribution of audit categories across production writers changed. " +
        "That is a change to WHO CAN READ WHAT — `admin`, `security` and `system` " +
        "are readable with support:view alone, while `family`, `account`, " +
        "`communication` and `privacy` need membership:view as well. Update " +
        "AUDIT_CENSUS_TOTALS.categoryValues and say so in the changelog.",
    ).toEqual(AUDIT_CENSUS_TOTALS.categoryValues);
  });

  it("chooses no category by WHO ACTED", () => {
    /*
      The owner's binding rule on #2581: category follows the affected business
      DOMAIN, never the actor. The member-photo writers used to read
      `category: actor.onBehalf ? "admin" : "account"` — the same action on the same
      record filed in two different categories, hence read by two different
      permission sets, depending on whether an administrator did it for the member.

      A conditional between literals is not always wrong in principle, but there is
      no legitimate one today, so the honest pin is zero: a new one has to argue for
      itself in a diff rather than arrive as an idiom.
    */
    const offenders = census().conditional.map(
      (site) => `${site.id} → ${describeCategory(site.category)}`,
    );

    expect(
      offenders,
      "An audit writer picks its category with a conditional. Category follows the " +
        "affected business domain, not who acted, so the same action on the same " +
        "record must land in the same category however it was initiated.",
    ).toEqual([]);
  });

  it("lets no writer decide its category outside the call site, except by declaration", () => {
    // A wrapper that takes `category` as a parameter, or forwards a whole event
    // object, is the shape that can smuggle a missing or invented value past both
    // the closed type and the site-level scan. Exactly one exists, and it is safe
    // because the type it forwards has a REQUIRED closed category.
    expect(
      ids(census().forwarded),
      "An audit writer's category comes from outside the call site — a variable, a " +
        "shorthand property, an opaque spread, or a forwarded event object. Either " +
        "pass a literal, or add the site to APPROVED_FORWARDED_CATEGORY_SITES with " +
        "the reason its indirection cannot drop or invent a category.",
    ).toEqual(Object.keys(APPROVED_FORWARDED_CATEGORY_SITES).sort());
  });

  it("has exactly the approved non-row-producing AuditLog statements", () => {
    // `update`/`updateMany`/`delete`/`deleteMany` on `auditLog` cannot carry a
    // category, so they must not be counted as omissions — but they are hand-written
    // mutations of the platform's audit trail, so they must not be invisible either.
    // Today they are the three retention statements, and nothing else.
    expect(
      ids(census().nonProducingDml),
      "Production code mutates or deletes AuditLog rows outside the approved " +
        "retention seam. Rewriting or removing audit evidence needs a reviewed " +
        "reason recorded in APPROVED_NON_PRODUCING_AUDIT_DML.",
    ).toEqual(Object.keys(APPROVED_NON_PRODUCING_AUDIT_DML).sort());
  });

  it("keeps every declared audit wrapper writing, with the category it declared", () => {
    /*
      A wrapper is one syntactic site standing for many logical events, so the
      site-level pins above under-count it and a change inside it can go unseen. The
      fourteen wrappers are declared with the sink they reach and the category they
      pass; a wrapper that stops writing, changes sink, or changes category fails
      here.

      `recordAgeUpParentEmailHandoffAudit` is in the list because it is a hand-built
      Prisma `create` rather than a helper call, so it bypasses the boundary's
      sanitisation while putting a recipient email address in its metadata.
    */
    const measured = Object.fromEntries(
      census()
        .sites.filter((site) => site.id in AUDIT_WRITER_WRAPPERS)
        .map((site) => [
          site.id,
          { sink: site.sink, category: describeCategory(site.category) },
        ]),
    );

    expect(
      measured,
      "A declared audit wrapper stopped writing, changed its sink, or changed the " +
        "category it passes. Every caller of a wrapper inherits its answer, so this " +
        "is a change to many audit rows rather than to one call.",
    ).toEqual(AUDIT_WRITER_WRAPPERS);
  });

  it("keeps the census's own tooling out of the census", () => {
    // The scanner and the manifest name every sink in string form. If the walk ever
    // counted them the totals would drift with the tooling, which is the reason the
    // manifest lives under `scripts/audit/` rather than beside the writers.
    const selfReferences = census().sites.filter((site) =>
      site.file.startsWith("scripts/audit/"),
    );
    expect(selfReferences).toEqual([]);
  });

  it("finds no TypeScript audit write in scripts/ or prisma/", () => {
    // Both trees reach the same database without going through a route, so a seed or
    // an operator backfill could write audit rows with no request context and no
    // review. Neither does today; a first one should be a conversation.
    //
    // Scoped to TypeScript deliberately, because `prisma/` is NOT clean in SQL —
    // see the migration assertion below. An unqualified "nothing writes the table
    // outside src/" would have been false.
    const outsideSrc = [...census().sites, ...census().nonProducingDml].filter(
      (site) => !site.file.startsWith("src/"),
    );
    expect(ids(outsideSrc)).toEqual([]);
  });

  it("has exactly the approved raw-SQL AuditLog statements in migrations", () => {
    /*
      The form no TypeScript census can see, and the reason the assertion above is
      qualified. Two committed migrations write `"AuditLog"` in raw SQL: a
      door-code redaction (four UPDATEs) and an email-override cleanup (one INSERT).
      Both bypass `audit.ts` entirely — no metadata sanitisation, no retention
      derivation, no closed category type — so a third one needs the same review,
      and before this pin nothing would have shown it.

      The scan strips SQL comments first: the door-code migration's own header
      discusses `UPDATE "AuditLog"` as well as performing it, which is the same
      comment false positive that put a phantom uncategorised writer in this
      issue's title.
    */
    expect(census().sqlFilesScanned).toBeGreaterThan(250);

    expect(
      census().sqlStatements.map((statement) => statement.id).sort(),
      "A migration writes, rewrites or deletes AuditLog rows in raw SQL. That " +
        "bypasses the audit boundary's sanitisation, retention derivation and " +
        "category type, and it changes the club's own history, so it must be " +
        "declared in APPROVED_MIGRATION_AUDIT_SQL with its reason.",
    ).toEqual(Object.keys(APPROVED_MIGRATION_AUDIT_SQL).sort());

    // And a row-producing INSERT must name the column, or its rows are born
    // uncategorised in exactly the way the 82 TypeScript sites are.
    expect(
      census()
        .sqlStatements.filter(
          (statement) => statement.producesRow && !statement.namesCategory,
        )
        .map((statement) => statement.id),
      "A migration INSERTs AuditLog rows without naming \"category\" in its " +
        "column list. Those rows are returned by no correlation tool and, unless " +
        "the migration also sets expiresAt by hand, are kept forever.",
    ).toEqual([]);
  });
});

describe("canonical audit taxonomy (#2581)", () => {
  it("gives every category a label and a correlation domain", () => {
    // The `Record<AuditCategory, …>` types already force this at compile time. The
    // runtime assertion is for the reverse direction: a key left behind after a
    // category is REMOVED from the list, which the exhaustive Record does not catch.
    expect(Object.keys(AUDIT_CATEGORY_LABELS).sort()).toEqual(
      [...AUDIT_CATEGORIES].sort(),
    );
    expect(Object.keys(AUDIT_CATEGORY_CORRELATION_DOMAIN).sort()).toEqual(
      [...AUDIT_CATEGORIES].sort(),
    );
  });

  it("pins the ADMIN AREAS each category's evidence needs", () => {
    /*
      The readership pin, and the reason the taxonomy is a security artefact rather
      than a display concern. A category IS a permission decision: it decides which
      correlation entry can return the row, and therefore which admin areas an
      operator must hold before the platform will show them the event.

      Pinned as a literal table so a change to `AUDIT_CATEGORY_CORRELATION_DOMAIN`
      cannot pass review as a refactor. Three categories sit behind `support:view`
      ALONE — `admin`, `security` and `system` — so moving a category INTO that row
      is the widening to argue for, and moving one OUT of it takes evidence away
      from a support-only operator who can read it today.
    */
    const measured = Object.fromEntries(
      AUDIT_CATEGORIES.map((category) => [
        category,
        [...auditCategoryReaderAreas(category)].join(" + "),
      ]),
    );

    expect(measured).toEqual({
      account: "support + membership",
      booking: "support + bookings",
      payment: "support + finance",
      xero: "support + finance",
      family: "support + membership",
      admin: "support",
      security: "support",
      lodge: "support + lodge",
      // Moved out of the support-only set in #2581 (decision 7): these payloads
      // carry recipient email addresses.
      communication: "support + membership",
      privacy: "support + membership",
      system: "support",
    });
  });

  it("pins how many write sites sit behind the WEAKEST gate", () => {
    // The number the "do not widen" constraint is really about. `admin`, `security`
    // and `system` are readable with `support:view` alone, so the count of writers
    // in them is the size of the population a support-only operator can correlate.
    // It moves only when a classification decision moves it, and then deliberately.
    const supportOnly = census().sites.filter(
      (site) =>
        site.category.kind === "literal" &&
        isAuditCategory(site.category.value) &&
        auditCategoryReaderAreas(site.category.value).length === 1,
    );

    expect(
      supportOnly.length,
      "The number of audit write sites readable with support:view alone changed. " +
        "That is a widening or a narrowing of who can correlate audit evidence, " +
        "not a refactor — say which in the changelog and update this pin.",
    ).toBe(
      AUDIT_CENSUS_TOTALS.categoryValues.admin +
        AUDIT_CENSUS_TOTALS.categoryValues.security +
        AUDIT_CENSUS_TOTALS.categoryValues.system,
    );
  });

  it("pins the categories a MEMBER can see in their own timeline", () => {
    /*
      The other readership boundary, and the one a taxonomy change can cross by
      accident. `audit-categories.ts` says membership of the canonical taxonomy must
      never publish a category to members as a side effect — but RE-classifying an
      existing writer still can, because the member timeline filters on category
      too (`buildMemberVisibleAuditLogWhere`).

      #2581 crossed it four times, all of them a writer moving from a category
      members cannot see into one they can: the three membership-application
      writers (invented `membership` → `account`), the auth-bounce writer (invented
      `auth` → `security`), and the on-behalf branch of the two member-photo
      writers (`admin` → `account`). Each row is about the member seeing it, and
      the member projection returns no metadata, no request id, no IP and no
      drill-downs — but "who can read this" changed, so it is pinned rather than
      left to be noticed.
    */
    const memberVisible = MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS.map(
      (option) => option.value,
    );

    expect(
      memberVisible,
      "The categories a member can see in their own audit timeline changed. That " +
        "publishes (or withdraws) a whole class of events on a member-facing " +
        "surface, so it is a reviewed decision — never a consequence of adding a " +
        "category to the taxonomy.",
    ).toEqual([
      "all",
      "account",
      "booking",
      "payment",
      "family",
      "security",
      "communication",
      "privacy",
    ]);

    // And the four the platform keeps to administrators.
    expect(
      AUDIT_CATEGORIES.filter(
        (category) => !memberVisible.includes(category),
      ),
    ).toEqual(["admin", "lodge", "xero", "system"]);
  });

  it("rejects the values that used to reach the database through the open union", () => {
    expect(isAuditCategory("membership")).toBe(false);
    expect(isAuditCategory("auth")).toBe(false);
    // And a plausible misspelling, which the old `(string & {})` escape also took.
    expect(isAuditCategory("familly")).toBe(false);
    expect(isAuditCategory("")).toBe(false);
    expect(isAuditCategory(undefined)).toBe(false);
    expect(isAuditCategory("family")).toBe(true);
  });
});
