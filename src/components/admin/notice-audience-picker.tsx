"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

// Audience input union sent to the notices API. Mirrors NoticeAudienceInput in
// the server-only `@/lib/notices` module; redeclared locally so this client
// component pulls in no server-only code.
export type Audience =
  | { kind: "ALL_MEMBERS" }
  | { kind: "MEMBER"; memberId: string }
  | { kind: "MEMBERSHIP_TYPE"; membershipTypeId: string }
  | { kind: "LODGE"; lodgeId: string }
  | { kind: "COMMITTEE_ROLE"; committeeRoleId: string };

// The audience shape the admin list/notice payload carries (kind + resolved
// name), used to prefill the picker on edit.
export type InitialAudience = {
  kind: string;
  targetId: string | null;
  targetName: string | null;
};

type NamedOption = { id: string; name: string };

type MemberResult = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
};

type MemberChip = { id: string; label: string };

interface NoticeAudiencePickerProps {
  /** Existing audience rows to seed the picker from (edit mode). */
  initialAudiences?: InitialAudience[];
  /** Emits the composed audience list whenever selections change. */
  onChange: (audiences: Audience[]) => void;
  /** Tri-state edit access; view-only / resolving disables every control. */
  canEdit: boolean | undefined;
  /** When true, surface the "at least one audience" validation message. */
  showValidation?: boolean;
}

function deriveInitialMode(
  initial: InitialAudience[] | undefined,
): "everyone" | "targeted" {
  if (!initial || initial.length === 0) return "everyone";
  return initial.some((a) => a.kind === "ALL_MEMBERS") ? "everyone" : "targeted";
}

function initialIdsForKind(
  initial: InitialAudience[] | undefined,
  kind: string,
): string[] {
  if (!initial) return [];
  return initial
    .filter((a) => a.kind === kind && a.targetId)
    .map((a) => a.targetId as string);
}

function initialMemberChips(
  initial: InitialAudience[] | undefined,
): MemberChip[] {
  if (!initial) return [];
  return initial
    .filter((a) => a.kind === "MEMBER" && a.targetId)
    .map((a) => ({
      id: a.targetId as string,
      label: a.targetName ?? "Member",
    }));
}

export function NoticeAudiencePicker({
  initialAudiences,
  onChange,
  canEdit,
  showValidation = false,
}: NoticeAudiencePickerProps) {
  const disabled = canEdit !== true;

  const [mode, setMode] = useState<"everyone" | "targeted">(() =>
    deriveInitialMode(initialAudiences),
  );
  const [typeIds, setTypeIds] = useState<string[]>(() =>
    initialIdsForKind(initialAudiences, "MEMBERSHIP_TYPE"),
  );
  const [lodgeIds, setLodgeIds] = useState<string[]>(() =>
    initialIdsForKind(initialAudiences, "LODGE"),
  );
  const [roleIds, setRoleIds] = useState<string[]>(() =>
    initialIdsForKind(initialAudiences, "COMMITTEE_ROLE"),
  );
  const [memberChips, setMemberChips] = useState<MemberChip[]>(() =>
    initialMemberChips(initialAudiences),
  );

  const [types, setTypes] = useState<NamedOption[]>([]);
  const [lodges, setLodges] = useState<NamedOption[]>([]);
  const [roles, setRoles] = useState<NamedOption[]>([]);
  const [listsError, setListsError] = useState<string | null>(null);
  const [lodgeListError, setLodgeListError] = useState<string | null>(null);
  const [listsReloadToken, setListsReloadToken] = useState(0);

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<MemberResult[]>([]);
  const [searching, setSearching] = useState(false);
  // Whether the member-search results popup is open. Driven open on typing and
  // dismissed on Escape / focus leaving the combobox (a lightweight combobox,
  // no arrow-key activedescendant navigation — the results stay tab-reachable).
  const [resultsOpen, setResultsOpen] = useState(false);

  // Load the three group audience sources once.
  useEffect(() => {
    let cancelled = false;
    async function loadLists() {
      setListsError(null);
      setLodgeListError(null);
      try {
        const [typesRes, lodgesRes, rolesRes] = await Promise.all([
          fetch("/api/admin/membership-types", { credentials: "same-origin" }),
          fetch("/api/admin/lodges", { credentials: "same-origin" }),
          fetch("/api/admin/committee/roles", { credentials: "same-origin" }),
        ]);
        if (cancelled) return;
        if (typesRes.ok) {
          const data = (await typesRes.json()) as {
            membershipTypes?: NamedOption[];
          };
          if (!cancelled) setTypes(data.membershipTypes ?? []);
        }
        if (lodgesRes.ok) {
          const data = (await lodgesRes.json()) as { lodges?: NamedOption[] };
          if (!cancelled) setLodges(data.lodges ?? []);
        } else if (!cancelled) {
          setLodges([]);
          setLodgeListError(
            lodgesRes.status === 403
              ? "Your role cannot view lodge audiences."
              : "Failed to load lodge audiences.",
          );
        }
        if (rolesRes.ok) {
          const data = (await rolesRes.json()) as { roles?: NamedOption[] };
          if (!cancelled) setRoles(data.roles ?? []);
        }
      } catch {
        if (!cancelled) {
          setListsError("Failed to load audience options. Please try again.");
        }
      }
    }
    loadLists();
    return () => {
      cancelled = true;
    };
  }, [listsReloadToken]);

  // Debounced member search.
  useEffect(() => {
    const term = search.trim();
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/members?search=${encodeURIComponent(term)}&pageSize=20`,
          { credentials: "same-origin" },
        );
        if (!res.ok) {
          if (!cancelled) setResults([]);
          return;
        }
        const data = (await res.json()) as { members?: MemberResult[] };
        if (!cancelled) setResults(data.members ?? []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [search]);

  const composed = useMemo<Audience[]>(() => {
    if (mode === "everyone") {
      return [{ kind: "ALL_MEMBERS" }];
    }
    const out: Audience[] = [];
    for (const id of typeIds) {
      out.push({ kind: "MEMBERSHIP_TYPE", membershipTypeId: id });
    }
    for (const id of lodgeIds) {
      out.push({ kind: "LODGE", lodgeId: id });
    }
    for (const id of roleIds) {
      out.push({ kind: "COMMITTEE_ROLE", committeeRoleId: id });
    }
    for (const chip of memberChips) {
      out.push({ kind: "MEMBER", memberId: chip.id });
    }
    return out;
  }, [mode, typeIds, lodgeIds, roleIds, memberChips]);

  // Keep the latest onChange in a ref so the emit effect can depend only on the
  // composed value, never on the parent's (possibly inline) callback identity.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    onChangeRef.current(composed);
  }, [composed]);

  const toggleId = useCallback(
    (setter: React.Dispatch<React.SetStateAction<string[]>>, id: string) => {
      setter((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
      );
    },
    [],
  );

  const addMember = useCallback((member: MemberResult) => {
    const label = `${member.firstName} ${member.lastName}`.trim() || member.email;
    setMemberChips((prev) =>
      prev.some((c) => c.id === member.id)
        ? prev
        : [...prev, { id: member.id, label }],
    );
    setSearch("");
    setResults([]);
    setResultsOpen(false);
  }, []);

  const removeMember = useCallback((id: string) => {
    setMemberChips((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const targetedEmpty = mode === "targeted" && composed.length === 0;
  const showResults = resultsOpen && search.trim().length >= 2;

  return (
    <div className="space-y-4">
      <div>
        <Label>Audience</Label>
        <p className="text-sm text-muted-foreground">
          Choose who this notice is for.
        </p>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="notice-audience-mode"
            className="size-4"
            checked={mode === "everyone"}
            disabled={disabled}
            onChange={() => setMode("everyone")}
          />
          <span>Everyone (all members)</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="notice-audience-mode"
            className="size-4"
            checked={mode === "targeted"}
            disabled={disabled}
            onChange={() => setMode("targeted")}
          />
          <span>Targeted (specific groups or members)</span>
        </label>
      </div>

      {mode === "targeted" ? (
        <div className="space-y-5 rounded-md border border-border p-4">
          {listsError ? (
            <p className="text-sm text-danger-11">{listsError}</p>
          ) : null}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Membership types</legend>
            {types.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No membership types available.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {types.map((t) => (
                  <label
                    key={t.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={typeIds.includes(t.id)}
                      disabled={disabled}
                      onCheckedChange={() => toggleId(setTypeIds, t.id)}
                    />
                    <span>{t.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Lodges</legend>
            {lodgeListError ? (
              <div className="space-y-2 text-xs text-danger-11">
                <p>{lodgeListError}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setListsReloadToken((value) => value + 1)}
                >
                  Try again
                </Button>
              </div>
            ) : lodges.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No lodges available.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {lodges.map((l) => (
                  <label
                    key={l.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={lodgeIds.includes(l.id)}
                      disabled={disabled}
                      onCheckedChange={() => toggleId(setLodgeIds, l.id)}
                    />
                    <span>{l.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Committee roles</legend>
            {roles.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No committee roles available.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {roles.map((r) => (
                  <label
                    key={r.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={roleIds.includes(r.id)}
                      disabled={disabled}
                      onCheckedChange={() => toggleId(setRoleIds, r.id)}
                    />
                    <span>{r.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="notice-member-search">Specific members</Label>
            {memberChips.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {memberChips.map((chip) => (
                  <span
                    key={chip.id}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs"
                  >
                    {chip.label}
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                      aria-label={`Remove ${chip.label}`}
                      disabled={disabled}
                      onClick={() => removeMember(chip.id)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div
              className="relative"
              onBlur={(e) => {
                // Focus leaving the combobox (Tab-out, or a click on anything
                // outside) dismisses the popup. A relatedTarget still inside the
                // container keeps it open, so clicking a result button lands its
                // onClick before the popup closes.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setResultsOpen(false);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && resultsOpen) {
                  e.stopPropagation();
                  setResultsOpen(false);
                }
              }}
            >
              <Input
                id="notice-member-search"
                value={search}
                disabled={disabled}
                placeholder="Search members by name or email..."
                onChange={(e) => {
                  setSearch(e.target.value);
                  setResultsOpen(true);
                }}
                autoComplete="off"
                role="combobox"
                aria-expanded={showResults}
                aria-controls="notice-member-search-results"
                aria-autocomplete="list"
              />
              {showResults ? (
                <div
                  id="notice-member-search-results"
                  role="listbox"
                  className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-border bg-background shadow-md"
                >
                  {searching ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      Searching...
                    </p>
                  ) : results.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      No members found.
                    </p>
                  ) : (
                    <ul className="max-h-56 overflow-y-auto">
                      {results.map((member) => {
                        const already = memberChips.some(
                          (c) => c.id === member.id,
                        );
                        return (
                          <li key={member.id}>
                            <button
                              type="button"
                              className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                              disabled={disabled || already}
                              onClick={() => addMember(member)}
                            >
                              <span>
                                {`${member.firstName} ${member.lastName}`.trim() ||
                                  member.email}
                                {already ? " (added)" : ""}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {member.email}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Members targeted individually always see the notice, even if
              &ldquo;Financial members only&rdquo; is on.
            </p>
          </div>

          {showValidation && targetedEmpty ? (
            <p className="text-sm text-danger-11">
              Select at least one group or member, or choose &ldquo;Everyone&rdquo;.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
