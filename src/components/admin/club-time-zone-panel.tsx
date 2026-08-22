"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listSelectableClubTimeZones } from "@/lib/club-time-zone";

/**
 * The club-timezone maintenance panel (CT-1, #2989; epic #2988).
 *
 * WHY THIS SURFACE DOES NOT USE `ViewOnlyActionButton` /
 * `AdminViewOnlySectionBanner`, and please do not "fix" it to. Those are the
 * canonical furniture for a section with a VIEW tier and an EDIT tier: they
 * resolve `useAdminAreaEditAccess(area)` and explain that this admin can look but
 * not change, because their access role grants the area at `view`. This screen has
 * exactly one permission level — Full Admin, enforced in the route by
 * `requireAdmin({ permission: false })` — so there is no area-edit tier to
 * describe, and rendering that banner here would state a REASON that is not the
 * reason. `/admin/club-time`'s page shell therefore does what
 * `/admin/config-transfer` does: it tests `isFullAdmin` and shows a short
 * "available to full administrators only" panel instead of this one.
 *
 * IT STILL FOLLOWS THE STAGED-EDIT MODEL (`docs/ARCHITECTURE.md` -> "Admin/member
 * layer"). The panel mounts READ-ONLY showing the configured zone; changing it is
 * Edit -> choose -> acknowledge -> Save. Nothing persists on selection, and the
 * acknowledgement is not decoration — the API refuses an unconfirmed change, so a
 * caller that skips this panel gets the same refusal.
 *
 * THE BROWSER NEVER DECIDES THE TIMEZONE. The configured zone always arrives from
 * the server (`GET /api/admin/club-time-zone`). `Intl.DateTimeFormat()
 * .resolvedOptions().timeZone` — the viewer's own clock — is never read here, for
 * anything, not even as a default before the fetch settles: a member in London and
 * a member in Ohakune have to see the same club time. The 418-entry OPTION LIST
 * does come from this runtime (`listSelectableClubTimeZones`), which is a list of
 * choices rather than a decision, and every choice is re-validated server-side.
 */

type ClubTimeZoneSource = "persisted" | "environment" | "default";

type ClubTimeZoneState = {
  timeZone: string;
  source: ClubTimeZoneSource;
  updatedAt: string | null;
  updatedByName: string | null;
};

/**
 * The three provenance words the operator guide uses, and the sentence behind
 * each. `docs/guides/club-time.md` names them verbatim, so they are the labels
 * rather than a paraphrase — a screen and a guide that describe the same state in
 * different words is how an operator stops trusting the guide.
 */
const SOURCE_LABEL: Record<ClubTimeZoneSource, string> = {
  persisted: "Configured",
  environment: "From the environment",
  default: "Default",
};

const SOURCE_EXPLANATION: Record<ClubTimeZoneSource, string> = {
  persisted: "Recorded in this installation's settings — the club has chosen it.",
  environment:
    "Nothing has been recorded yet, so this is the zone the server was started " +
    "with. Restarting the app records it; so does saving below.",
  default:
    "Nothing has been recorded and the server says nothing either, so this is " +
    "the shipped default. Saving below records the club's own choice.",
};

/**
 * "Last changed" spelled in the CLUB's configured zone — which is the panel
 * practising exactly what it explains below. The zone comes from the server
 * payload, never from `resolvedOptions()`, and it is passed explicitly because an
 * `Intl.DateTimeFormat` with no `timeZone` renders in the viewer's own (INV-DATE-015,
 * and the ESLint date guard refuses one). It is deliberately NOT `APP_TIME_ZONE`:
 * that transitional constant still derives from the environment and is retired by
 * CT-6, and this screen is the one place that must show the configured value.
 */
function formatChangedAt(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-NZ", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Match on the identifier with underscores read as spaces: "new york" finds America/New_York. */
function matchesFilter(zone: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return zone.toLowerCase().replace(/_/g, " ").includes(needle.replace(/_/g, " "));
}

export function ClubTimeZonePanel() {
  const [state, setState] = useState<ClubTimeZoneState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filterId = useId();
  const selectId = useId();
  const acknowledgeId = useId();

  // Built once, from this runtime's zone database. Offering the list is not
  // deciding the zone; see the module doc.
  const allZones = useMemo(() => listSelectableClubTimeZones(), []);

  function load() {
    setLoadFailed(false);
    void fetch("/api/admin/club-time-zone")
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        const payload = (await response.json()) as { state: ClubTimeZoneState };
        setState(payload.state);
      })
      .catch(() => setLoadFailed(true));
  }

  useEffect(() => {
    load();
  }, []);

  if (loadFailed) {
    return (
      <div className="space-y-3 rounded-md border bg-card p-6">
        <p className="text-sm text-danger">
          Could not load the club time zone.
        </p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  if (!state) {
    return (
      <p className="text-sm text-muted-foreground">Loading club time zone…</p>
    );
  }

  const chosen = choice ?? state.timeZone;
  /*
    RECORDING THE ZONE THE CLUB IS ALREADY EFFECTIVELY ON IS A REAL SAVE, and it
    is the state a fresh install and an upgraded one both arrive in. Until a valid
    row exists the answer is coming from `TZ` or from the shipped default, and the
    whole point of CT-1 is that the club's own choice is recorded rather than
    inferred — so "Save" stays available even when the chosen zone equals the one
    displayed. The server agrees: with nothing persisted there is no before-value
    to match, so the write happens and the audit row records `before: null`. Once
    a row exists, re-picking the same zone is the pristine re-save the dirty gate
    is there to refuse.
  */
  const nothingRecordedYet = state.source !== "persisted";
  const unchanged = chosen === state.timeZone && !nothingRecordedYet;
  /*
    The chosen zone is ALWAYS offered, even when the filter excludes it and even
    when this runtime's `supportedValuesOf` does not list it — ICU disagrees with
    itself across versions about which spelling is canonical (`Asia/Calcutta` vs
    `Asia/Kolkata`), so a perfectly good stored zone can be absent from the list.
    Without this the `<select>` would have no option matching its own value and
    would silently display a zone the club is not on.
  */
  const filteredZones = allZones.filter((zone) => matchesFilter(zone, filter));
  const visibleZones = filteredZones.includes(chosen)
    ? filteredZones
    : [chosen, ...filteredZones];

  function startEditing() {
    setChoice(state?.timeZone ?? null);
    setFilter("");
    setAcknowledged(false);
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setChoice(null);
    setFilter("");
    setAcknowledged(false);
    setError(null);
  }

  async function save() {
    if (!acknowledged || unchanged) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/club-time-zone", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeZone: chosen, confirmed: true }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { state?: ClubTimeZoneState; error?: string }
        | null;
      if (!response.ok || !payload?.state) {
        setError(payload?.error ?? "Could not save the club time zone.");
        return;
      }
      setState(payload.state);
      cancelEditing();
    } catch {
      setError("Could not save the club time zone.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 rounded-md border bg-card p-6">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">Club time zone</p>
        <p className="text-lg font-semibold" data-testid="current-club-time-zone">
          {state.timeZone}
        </p>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium">{SOURCE_LABEL[state.source]}</span>
          {` — ${SOURCE_EXPLANATION[state.source]}`}
        </p>
        {state.updatedAt ? (
          <p className="text-sm text-muted-foreground">
            {`Last changed ${formatChangedAt(state.updatedAt, state.timeZone)}`}
            {state.updatedByName ? ` by ${state.updatedByName}` : null}
          </p>
        ) : null}
      </div>

      {!editing ? (
        <Button onClick={startEditing}>Change time zone</Button>
      ) : (
        <div className="space-y-4 border-t pt-4">
          <div className="space-y-2">
            <Label htmlFor={filterId}>Find a time zone</Label>
            <Input
              id={filterId}
              value={filter}
              placeholder="Type a city or region, for example Auckland"
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={selectId}>Time zone</Label>
            <select
              id={selectId}
              value={chosen}
              onChange={(event) => setChoice(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            >
              {visibleZones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {visibleZones.length} of {allZones.length} time zones shown.
            </p>
          </div>

          <div className="space-y-3 rounded-md border border-warning-6 bg-warning-2 p-4">
            <p className="text-sm font-semibold">
              What changing the club time zone does
            </p>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Now</dt>
                <dd className="font-medium" data-testid="confirm-current-zone">
                  {state.timeZone}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">After saving</dt>
                <dd className="font-medium" data-testid="confirm-chosen-zone">
                  {chosen}
                </dd>
              </div>
            </dl>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>
                Dates and times already recorded are not rewritten or moved.
                Nothing in the database changes except this setting.
              </li>
              <li>
                What changes is how times are shown from now on, and when
                club-local scheduled jobs — reminders, nightly work, cut-offs —
                fire.
              </li>
              <li>
                Lodge nights keep the calendar dates they already have. A booking
                for the 14th is still a booking for the 14th.
              </li>
            </ul>
            <div className="flex items-start gap-2">
              <Checkbox
                id={acknowledgeId}
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked)}
              />
              <Label htmlFor={acknowledgeId} className="text-sm font-normal">
                I understand that saving changes how times are displayed and when
                club-local scheduled jobs fire, and that it does not move any date
                or time already recorded.
              </Label>
            </div>
          </div>

          {unchanged ? (
            <p className="text-sm text-muted-foreground">
              {chosen} is already the club time zone. Choose a different one to
              save a change.
            </p>
          ) : null}
          {error ? <p className="text-sm text-danger">{error}</p> : null}

          <div className="flex gap-2">
            <Button
              onClick={() => void save()}
              disabled={!acknowledged || unchanged || saving}
            >
              {saving ? "Saving…" : "Save time zone"}
            </Button>
            <Button variant="outline" onClick={cancelEditing} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
