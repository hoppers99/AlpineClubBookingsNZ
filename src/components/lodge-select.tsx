"use client";

import { useCallback, useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface LodgeOption {
  id: string;
  name: string;
  travelNote?: string | null;
  /**
   * Whether the lodge is open for booking. Absent on every list a member,
   * booking, display or ordinary admin surface builds, because those lists are
   * filtered to active lodges before they get here and an absent value reads as
   * active throughout.
   *
   * Present, and sometimes `false`, only on a CONFIGURATION list
   * (`useLodgeOptions("configuration")`). A lodge created through the setup
   * flow starts inactive (#221), and configuring it — its rooms, lockers,
   * seasons, rates and chores — is the entire point of the period before it
   * opens. So those five editors have to be able to name it, which means the
   * selector has to be able to SHOW it, labelled, rather than quietly
   * substituting an open lodge.
   */
  active?: boolean;
}

/** Absent `active` reads as open — see {@link LodgeOption.active}. */
function isOpen(lodge: LodgeOption): boolean {
  return lodge.active !== false;
}

/**
 * The value of a DELIBERATE club-wide selection (#2701), for the callers that
 * opt into it with `allowAllLodges`.
 *
 * It is a sentinel string rather than `null` because `null` was already
 * carrying three unrelated meanings on the bed-allocation board — "I chose to
 * see everything", "the selector has not resolved yet" and "the lodge list
 * failed to load" — and the four bed pickers behaved identically in all three.
 * A sentinel makes the deliberate case its own value, so `null` is left meaning
 * only "not resolved". Not a possible cuid, so it can never collide with a real
 * lodge id, and callers must never send it to an API as a `lodgeId`.
 */
export const ALL_LODGES = "__all_lodges__";

/**
 * Who asked for the change. `"user"` is the admin operating the selector;
 * `"auto"` is this component's own normalising effect (the sole-lodge rule and
 * the first-lodge default). Callers that treat a lodge change as "the admin
 * browsed away from something" must act on `"user"` alone — inferring it from
 * the values, as the bed-allocation board used to, cannot tell a default apart
 * from a choice that happens to pick the same lodge.
 */
export type LodgeChangeSource = "user" | "auto";

/**
 * How a lodge that is not open for booking is labelled wherever a configuration
 * surface offers it (#221). One constant so the selector option, the sole-lodge
 * scope line and the tests cannot drift apart.
 */
export const CLOSED_SUFFIX = "(closed)";

// Shared lodge selector honouring the single-lodge presentation rule
// (docs/multi-lodge/decisions/ADR-002): when fewer than two lodges are
// offered it renders nothing and reports the sole lodge (or null) through
// onChange, so surrounding flows behave exactly as a single-lodge club.
export function LodgeSelect({
  lodges,
  value,
  onChange,
  label = "Lodge",
  id = "lodge-select",
  loading = false,
  allowAllLodges = false,
  deferDefaultSelection = false,
}: {
  lodges: LodgeOption[];
  value: string | null;
  onChange: (lodgeId: string | null, source: LodgeChangeSource) => void;
  label?: string;
  id?: string;
  // True while the lodge options are still being fetched. The sole-lodge /
  // default-selection normalisation must not run against an empty
  // still-loading list, or it clobbers a caller-provided initial selection
  // (e.g. a ?lodgeId= hub link, ADR-003) before the options arrive.
  loading?: boolean;
  /**
   * Offer `ALL_LODGES` as an explicit option (#2701). Off by default: a page
   * that cannot render a club-wide view must not be able to reach one, and
   * with it off an `ALL_LODGES` value arriving from a URL is normalised away
   * like any other unusable selection.
   */
  allowAllLodges?: boolean;
  /**
   * Hold the first-lodge default off while the CALLER is still resolving an
   * authoritative selection of its own — a deep-linked booking whose lodge
   * only the server knows (#2701). Without it the selector would default to
   * `lodges[0]` in the meantime, which is precisely how a lodge-B booking used
   * to land on lodge A's board.
   */
  deferDefaultSelection?: boolean;
}) {
  // The lodge the CALLER is currently pointed at, when it is one this list
  // offers. Used below to tell a deliberate selection apart from a stale value.
  const named = lodges.find((lodge) => lodge.id === value) ?? null;
  const namedIsClosed = named !== null && !isOpen(named);

  useEffect(() => {
    if (loading || deferDefaultSelection) return;
    /*
      #221 — a CLOSED lodge is only ever reached because somebody NAMED it: a
      `?lodgeId=` configuration link from the per-lodge setup flow or the lodge
      hub, or a pick from this selector. Nothing below ever auto-chooses one,
      so a value that resolves to a closed lodge is deliberate by construction
      and must survive normalisation.

      Without this the sole-lodge rule fired instead: a club with one open
      lodge plus the closed one being set up counts ONE open lodge, so the rule
      below reported the open lodge through `onChange` — and every room, bed,
      locker, season, rate and chore the operator then created landed on the
      wrong lodge, with no selector on screen to show it had happened.
    */
    if (namedIsClosed) return;

    // Everything from here is the ADR-002 rule, which counts OPEN lodges. On
    // every non-configuration list that is the whole list, so this is the
    // behaviour those surfaces have always had.
    const open = lodges.filter(isOpen);
    if (open.length < 2) {
      // ADR-002: fewer than two lodges is a single-lodge club, where there is
      // no club-wide view to choose — so even an explicit ALL_LODGES
      // normalises to the sole lodge (or to null when the list is empty).
      const sole = open[0]?.id ?? null;
      if (value !== sole) onChange(sole, "auto");
      return;
    }
    // A deliberate club-wide selection is a settled value, never normalised
    // away — that is the entire point of making it explicit.
    if (allowAllLodges && value === ALL_LODGES) return;
    if (
      value === null ||
      value === ALL_LODGES ||
      !open.some((lodge) => lodge.id === value)
    ) {
      onChange(open[0].id, "auto");
    }
  }, [
    lodges,
    value,
    onChange,
    loading,
    allowAllLodges,
    deferDefaultSelection,
    namedIsClosed,
  ]);

  if (lodges.length < 2) {
    /*
      The single-lodge suppression is only safe while it is REDUNDANT. Standing
      on a closed lodge it is not: the operator is editing a building nobody can
      book, and silence there is indistinguishable from editing the open one.
      (Reachable in a club whose one and only lodge is closed: `POST
      /api/admin/lodges` now defaults `active` to `false` with no first-lodge
      exception (#221), and the config-transfer importer's `buildLodgeData`
      treats an omitted `active` field in a restored `lodge.json` descriptor
      the same way. Both are real entry paths, not insurance against an
      unreachable state.)
    */
    if (namedIsClosed) {
      return (
        <p className="text-sm text-muted-foreground" data-testid="lodge-scope-line">
          {label}: {named.name} {CLOSED_SUFFIX}
        </p>
      );
    }
    return null;
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? undefined}
        onValueChange={(next) => onChange(next, "user")}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose a lodge" />
        </SelectTrigger>
        <SelectContent>
          {allowAllLodges ? (
            <SelectItem value={ALL_LODGES}>All lodges</SelectItem>
          ) : null}
          {lodges.map((lodge) => (
            <SelectItem key={lodge.id} value={lodge.id}>
              {isOpen(lodge) ? lodge.name : `${lodge.name} ${CLOSED_SUFFIX}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Initial lodge context from a `?lodgeId=` URL parameter (ADR-003 hub
 * links), for a page's `useState` initialiser. Read synchronously on the
 * client so the page's very first data fetch is already lodge-filtered —
 * applying it in an effect creates an unfiltered-then-filtered request pair
 * whose responses can land out of order and show the wrong lodge's data.
 * During SSR there is no window and the value starts null, which is safe:
 * nothing lodge-dependent renders before the options load.
 */
export function initialLodgeIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("lodgeId");
}

/**
 * Fetch lodges for the current user.
 *
 * | scope | endpoint | inactive lodges |
 * | --- | --- | --- |
 * | `"member"` | `/api/lodges` | dropped |
 * | `"admin"` | `/api/admin/lodges` | dropped |
 * | `"configuration"` | `/api/admin/lodges` | KEPT, carrying `active` |
 *
 * `"admin"` returns every ACTIVE lodge (admin pages pass their own endpoint
 * data instead where they already load it).
 *
 * `"configuration"` (#221) is for the five full editors that build a lodge's
 * OWN inventory — Rooms & Beds, Lockers, Seasons, Fees and Chores — and for
 * nothing else. A lodge created through the setup flow starts inactive, and
 * those editors are exactly where its rooms, lockers, seasons, rates and chores
 * get made; their routes already accept an inactive lodge through
 * `resolveOptionalConfigurableLodgeId` (see
 * `docs/multi-lodge/lodge-scoping-contract.md`). Dropping the lodge here was
 * therefore the client half of the same question answered the opposite way, and
 * the consequence was silent: `LodgeSelect` substituted an open lodge and the
 * operator's writes landed on it.
 *
 * The split is deliberately at the SCOPE and not at the route, so that adding a
 * consumer cannot widen anything by accident: every member, booking, roster,
 * display and kiosk surface keeps the filtered list it has always had, and
 * `lodge-option-consumer-census.test.ts` pins which files may ask for which
 * scope.
 *
 * `failed` and `reload` exist so a caller can tell a FAILED list apart from an
 * empty one (#2701). Before this the two were indistinguishable — a refused or
 * unreachable `/api/admin/lodges` produced `lodges: []` exactly like a club
 * with no active lodges, and on the bed-allocation board that silently became
 * an unscoped club-wide read nobody chose. Existing callers that destructure
 * only `lodges`/`loading` are unaffected: on failure they still see the empty
 * list they saw before.
 *
 * `forbidden` is kept SEPARATE from `failed`, because a refusal is a
 * permissions fact with a retry that can only refuse again, where a failure is
 * an outage worth retrying (PR #2885 review, HIGH 2). A caller can offer a
 * refused role the club-wide read-only view instead of a dead error.
 *
 * WHO can still be refused changed in #2925. `/api/admin/lodges` no longer
 * needs `lodge:view`: it admits any admitted admin (`overview:view`) and
 * narrows its payload instead, so the two shipped presets this state was
 * written for — `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN`, which hold
 * `bookings: "view"` and no `lodge` entry — now get a 200 carrying the lodge
 * names. `forbidden` is NOT dead code: every shipped admin preset carries
 * `overview`, but a club-edited or custom role can hold `bookings: "view"` with
 * `overview: "none"` and reach a bookings page, and that role is still refused
 * here. So the state stays, and so does every caller's handling of it.
 */
export type LodgeOptionScope = "member" | "admin" | "configuration";

export function useLodgeOptions(scope: LodgeOptionScope = "member") {
  const [lodges, setLodges] = useState<LodgeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // `configuration` is a wider view of the ADMIN list, not a third endpoint:
    // the member endpoint has no business serving a lodge nobody can book.
    const url = scope === "member" ? "/api/lodges" : "/api/admin/lodges";
    setLoading(true);
    setFailed(false);
    setForbidden(false);
    fetch(url)
      .then(async (response) => {
        // A refusal is not an empty club. Previously this returned
        // `{ lodges: [] }` and the caller could not tell the difference.
        if (response.status === 403) {
          if (!cancelled) {
            setLodges([]);
            setForbidden(true);
          }
          return null;
        }
        if (!response.ok) throw new Error(`lodge options ${response.status}`);
        return (await response.json()) as {
          lodges?: Array<LodgeOption & { active?: boolean }>;
        };
      })
      .then((data) => {
        if (cancelled || data === null) return;
        if (scope === "configuration") {
          // Every lodge, each carrying whether it is open. `active` is normalised
          // to a real boolean here (an endpoint that omits it means open) so a
          // consumer never has to repeat the absent-means-open rule.
          setLodges(
            (data.lodges ?? []).map(({ id, name, travelNote, active }) => ({
              id,
              name,
              travelNote,
              active: active !== false,
            })),
          );
          return;
        }
        const rows = (data.lodges ?? []).filter(
          (lodge) => !("active" in lodge) || lodge.active !== false,
        );
        setLodges(rows.map(({ id, name, travelNote }) => ({ id, name, travelNote })));
      })
      .catch(() => {
        if (cancelled) return;
        setLodges([]);
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, attempt]);

  const reload = useCallback(() => setAttempt((current) => current + 1), []);

  return { lodges, loading, failed, forbidden, reload };
}
