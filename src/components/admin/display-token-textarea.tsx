"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import {
  DISPLAY_CONFIG_KEY_RULES,
  DISPLAY_STANDARD_TOKENS,
  displayConfigToken,
  isValidDisplayConfigKey,
  listDisplayCssInsertTokens,
  normaliseDisplayConfigKey,
  suggestDisplayConfigKey,
  unsetDisplayConfigPlaceholder,
} from "@/lib/lodge-display/display-token-catalogue";

// The Lodge TV token assistant (#2248): ONE shared labelled-textarea-with-picker
// used by every authored display surface — the builder's Footer HTML, CSS
// overrides and zone HTML block, and the advanced Templates page's CSS/footer
// fields — so wording, keys and behaviour cannot drift between them.
//
// An "Insert token" button on the field's label row opens a searchable
// command-palette popover listing only what that field kind accepts:
//  • HTML fields — the closed display token grammar (display-text.ts): the two
//    standard value tokens, then the selected preview lodge's live
//    `{{config:…}}` keys with their saved values as row descriptions (owner
//    decision 1: live values shown, sourced from the preview-lodge selector via
//    the lodge:view-gated GET /api/admin/display/lodge-config — decision 2),
//    plus free-text entry that turns a typed key into `{{config:<key>}}`. A key
//    with no saved value is still insertable, with a warning naming the exact
//    placeholder the wall will show (decision 3).
//  • CSS fields — the theme custom properties from `listDisplayCssTokens()`,
//    inserted as ready-to-use `var(--…)` usages.
//
// Insertion is caret-aware — the repo's first: the token lands where the caret
// was (replacing any selection), focus returns to the textarea with the
// inserted run selected, and a polite live region announces the insert. The
// existing static token explainer paragraphs on both pages stay as they are;
// the picker is additive (decision 4).

/**
 * Marker attribute carried by the assistant's root wrapper (trigger button +
 * popover) WHILE the picker is open. The zone drawer's Radix Sheet checks it in
 * `onEscapeKeyDown` so Escape pressed anywhere in an open picker — including on
 * the trigger itself, reachable via Shift+Tab — closes the picker only, never
 * the whole drawer (Radix's document-capture listener fires before this
 * component's own handler can stop propagation). With the picker closed the
 * attribute is absent, so Escape dismisses the drawer as normal.
 */
export const DISPLAY_TOKEN_POPOVER_ATTR = "data-display-token-popover";

/** The preview lodge's live display config, as the picker consumes it. */
export interface DisplayConfigSource {
  status: "loading" | "ready" | "error";
  lodgeName: string;
  entries: { key: string; value: string }[];
}

/**
 * Fetch one lodge's saved `displayConfig` for the picker (decision 2: the same
 * lodge the page's existing "Preview lodge" selector points at; an empty
 * `lodgeId` lets the route resolve the club default lodge). Call once per page
 * and pass the result to every HTML-mode `DisplayTokenTextarea`.
 */
export function useDisplayLodgeConfig(lodgeId: string): DisplayConfigSource {
  const [source, setSource] = useState<DisplayConfigSource>({
    status: "loading",
    lodgeName: "",
    entries: [],
  });
  useEffect(() => {
    let cancelled = false;
    setSource({ status: "loading", lodgeName: "", entries: [] });
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/display/lodge-config${
            lodgeId ? `?lodgeId=${encodeURIComponent(lodgeId)}` : ""
          }`
        );
        const body = res.ok
          ? ((await res.json().catch(() => null)) as {
              lodgeName?: unknown;
              displayConfig?: unknown;
            } | null)
          : null;
        if (cancelled) return;
        if (!body) {
          setSource({ status: "error", lodgeName: "", entries: [] });
          return;
        }
        const config =
          body.displayConfig &&
          typeof body.displayConfig === "object" &&
          !Array.isArray(body.displayConfig)
            ? (body.displayConfig as Record<string, unknown>)
            : {};
        const entries = Object.entries(config)
          .filter((pair): pair is [string, string] => typeof pair[1] === "string")
          .map(([key, value]) => ({ key, value }))
          .sort((a, b) => a.key.localeCompare(b.key));
        setSource({
          status: "ready",
          lodgeName: typeof body.lodgeName === "string" ? body.lodgeName : "",
          entries,
        });
      } catch {
        if (!cancelled) setSource({ status: "error", lodgeName: "", entries: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lodgeId]);
  return source;
}

export interface DisplayTokenTextareaProps {
  id: string;
  label: ReactNode;
  /** What the field accepts: display HTML tokens, or CSS theme tokens. */
  mode: "html" | "css";
  value: string;
  onValueChange: (next: string) => void;
  /** Required, never truthy-defaulted (#2065 house convention): every caller
   * must state its access decision explicitly, typically `disabled={!canEdit}`. */
  disabled: boolean;
  placeholder?: string;
  /** Extra textarea classes (typically a min-height like `min-h-20`). */
  textareaClassName?: string;
  /** HTML mode: the preview lodge's live config keys (see useDisplayLodgeConfig). */
  configSource?: DisplayConfigSource;
}

const KBD_CLASS =
  "rounded border border-border bg-background px-1 font-mono text-[10px]";
const NOTE_WARN_CLASS =
  "mx-1 mb-1 rounded-sm border border-warning-7/50 bg-warning-3 px-2 py-1.5 text-xs text-warning-11";
const NOTE_INFO_CLASS =
  "mx-1 mb-1 rounded-sm border border-info-7/50 bg-info-3 px-2 py-1.5 text-xs text-info-11";

/**
 * A labelled monospace textarea with the token assistant on its label row.
 * Renders as siblings (label row, textarea, live region) so it drops into the
 * existing `space-y-1` field wrappers unchanged.
 */
export function DisplayTokenTextarea(props: DisplayTokenTextareaProps) {
  const { mode } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [pendingSelection, setPendingSelection] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Last known caret/selection; null until the author first touches the field
   * (then inserts append at the end rather than guessing position 0). */
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** Alternates an invisible announcement suffix so repeat inserts re-announce. */
  const announceTickRef = useRef(false);

  const cssTokens = useMemo(
    () => (mode === "css" ? listDisplayCssInsertTokens() : []),
    [mode]
  );

  function captureSelection(event: SyntheticEvent<HTMLTextAreaElement>) {
    const el = event.currentTarget;
    selectionRef.current = {
      start: el.selectionStart ?? 0,
      end: el.selectionEnd ?? 0,
    };
  }

  function closeAndRestore() {
    setOpen(false);
    const el = textareaRef.current;
    if (el && !props.disabled) {
      el.focus();
      const sel = selectionRef.current;
      if (sel) el.setSelectionRange(sel.start, sel.end);
    }
  }

  function insertToken(text: string) {
    const fallback = { start: props.value.length, end: props.value.length };
    const sel = selectionRef.current ?? fallback;
    // A stale selectionRef (e.g. the parent reset `value` under us) is safe:
    // String.slice and setSelectionRange both clamp out-of-range offsets to the
    // value's end, so the worst case is an append, never a crash.
    const start = Math.min(sel.start, sel.end);
    const end = Math.max(sel.start, sel.end);
    // At the caret, replacing any selection — never appended to the end.
    //
    // Two write paths on purpose. Preferred: `execCommand("insertText")` on the
    // focused textarea (the page-content-panel precedent) so the browser's
    // NATIVE UNDO STACK survives the insert — React's onChange still fires from
    // the resulting input event, so the controlled value stays in sync. Writing
    // through the controlled value directly would reset undo history, so that
    // path is kept only as a fallback where execCommand is unavailable or
    // refuses (jsdom implements no execCommand, so tests exercise the
    // fallback). Both paths end in the same pendingSelection restore, so the
    // focus/selection behaviour is identical either way.
    let inserted = false;
    const el = textareaRef.current;
    if (el && typeof document.execCommand === "function") {
      el.focus();
      el.setSelectionRange(Math.min(start, el.value.length), Math.min(end, el.value.length));
      try {
        inserted = document.execCommand("insertText", false, text);
      } catch {
        inserted = false;
      }
    }
    if (!inserted) {
      props.onValueChange(
        props.value.slice(0, start) + text + props.value.slice(end)
      );
    }
    setPendingSelection({ start, end: start + text.length });
    setOpen(false);
    setQuery("");
    // The visual highlight (the run is left selected) is not enough on its own;
    // announce the insert politely for screen-reader users. The alternating
    // invisible suffix (nbsp) keeps a REPEAT insert of the same token from
    // being a no-op state update — identical strings would bail out of the
    // re-render and the live region would stay silent the second time.
    announceTickRef.current = !announceTickRef.current;
    setAnnouncement(
      `Inserted ${text}${announceTickRef.current ? "\u00A0" : ""}`
    );
  }

  // Restore focus with the inserted run selected AFTER the controlled value has
  // reached the DOM (the parent's setState and ours batch into one commit).
  useEffect(() => {
    if (pendingSelection === null) return;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pendingSelection.start, pendingSelection.end);
      selectionRef.current = pendingSelection;
    }
    setPendingSelection(null);
  }, [pendingSelection]);

  // Light dismissal: a click/tap outside closes without stealing focus.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onRootBlur(event: ReactFocusEvent<HTMLDivElement>) {
    if (!open) return;
    const next = event.relatedTarget as Node | null;
    if (next && !event.currentTarget.contains(next)) setOpen(false);
  }

  const q = query.trim().toLowerCase();
  const popoverId = `${props.id}-token-popover`;

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={props.id}>{props.label}</Label>
        <div
          ref={rootRef}
          className="relative"
          onBlur={onRootBlur}
          // While open, the whole assistant (trigger + popover) is marked for
          // the zone drawer's Sheet Escape guard — see DISPLAY_TOKEN_POPOVER_ATTR.
          {...(open ? { [DISPLAY_TOKEN_POPOVER_ATTR]: "" } : {})}
          // Escape is handled here on the ROOT wrapper, not the popover, so it
          // also covers focus resting on the trigger button (Shift+Tab from the
          // search input) — closing the picker only, never a surrounding
          // drawer/dialog. With the picker closed, Escape passes through.
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              closeAndRestore();
            }
          }}
        >
          <Button
            type="button"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={props.disabled}
            title={
              props.disabled
                ? "Lodge edit access is required to change this field."
                : undefined
            }
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? popoverId : undefined}
            onClick={() => {
              setQuery("");
              setOpen((current) => !current);
            }}
          >
            <span aria-hidden="true" className="font-mono">
              {"{ }"}
            </span>{" "}
            Insert token
          </Button>
          {open && (
            <div
              id={popoverId}
              role="dialog"
              aria-label={mode === "css" ? "Insert theme token" : "Insert token"}
              className="absolute right-0 top-full z-50 mt-1 w-[21rem] max-w-[85vw] rounded-md border bg-popover text-popover-foreground shadow-md"
            >
              <Command shouldFilter={false}>
                <CommandInput
                  autoFocus
                  value={query}
                  onValueChange={setQuery}
                  aria-label={
                    mode === "css" ? "Search theme tokens" : "Search tokens"
                  }
                  placeholder={
                    mode === "css"
                      ? "Search theme tokens…"
                      : "Search tokens, or type a config key…"
                  }
                />
                <CommandList>
                  {mode === "css" ? (
                    <CssTokenGroups q={q} tokens={cssTokens} onInsert={insertToken} />
                  ) : (
                    <HtmlTokenGroups
                      q={q}
                      rawQuery={query}
                      source={props.configSource}
                      onInsert={insertToken}
                    />
                  )}
                  <CommandEmpty>No matching token.</CommandEmpty>
                </CommandList>
              </Command>
              <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 border-t bg-muted px-3 py-1.5 text-[11px]">
                <span className="flex flex-wrap items-center gap-1">
                  <kbd className={KBD_CLASS}>↑</kbd>
                  <kbd className={KBD_CLASS}>↓</kbd> navigate ·{" "}
                  <kbd className={KBD_CLASS}>Enter</kbd> insert ·{" "}
                  <kbd className={KBD_CLASS}>Esc</kbd> close
                </span>
                <span>
                  {mode === "css"
                    ? "Inserts the ready-to-use var(--…)"
                    : "Inserts at the cursor"}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      <textarea
        ref={textareaRef}
        id={props.id}
        className={cn(
          "border-input bg-background w-full rounded-md border p-3 font-mono text-xs",
          props.textareaClassName
        )}
        spellCheck={false}
        disabled={props.disabled}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => {
          captureSelection(event);
          props.onValueChange(event.target.value);
        }}
        onFocus={captureSelection}
        onSelect={captureSelection}
      />
      {/* Permanently-mounted polite live region (house idiom): a region
          injected already-populated is dropped by some SR/browser pairings. */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </>
  );
}

function TokenRow({
  token,
  children,
}: {
  token: string;
  children?: ReactNode;
}) {
  return (
    <>
      <span className="font-mono text-xs">{token}</span>
      {children ? (
        <span className="text-muted-foreground min-w-0 flex-1 break-words text-xs">
          {children}
        </span>
      ) : null}
    </>
  );
}

function HtmlTokenGroups({
  q,
  rawQuery,
  source,
  onInsert,
}: {
  q: string;
  rawQuery: string;
  source: DisplayConfigSource | undefined;
  onInsert: (text: string) => void;
}) {
  const entries = source?.entries ?? [];
  const lodgeLabel = source?.lodgeName
    ? `${source.lodgeName} config keys`
    : "Lodge config keys";
  const configHeading =
    source?.status === "ready"
      ? `${lodgeLabel} · ${
          entries.length === 0
            ? "none saved"
            : `${entries.length} saved`
        }`
      : source?.status === "loading"
        ? `${lodgeLabel} · loading…`
        : lodgeLabel;

  const stdMatches = DISPLAY_STANDARD_TOKENS.filter(
    (t) =>
      q === "" ||
      t.token.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q)
  );
  const cfgMatches = entries.filter(
    (e) => q === "" || e.key.includes(q) || e.value.toLowerCase().includes(q)
  );
  const typedKey = normaliseDisplayConfigKey(rawQuery);
  const exactSaved = entries.some((e) => e.key === typedKey);
  const showFreeRow = typedKey !== "" && !exactSaved;
  const freeValid = isValidDisplayConfigKey(typedKey);
  const suggestion = freeValid ? "" : suggestDisplayConfigKey(rawQuery);

  return (
    <>
      {stdMatches.length > 0 && (
        <CommandGroup heading="Standard tokens">
          {stdMatches.map((t) => (
            <CommandItem
              key={t.token}
              value={t.token}
              className="items-baseline gap-2"
              onSelect={() => onInsert(t.token)}
            >
              <TokenRow token={t.token}>{t.description}</TokenRow>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {(q === "" || cfgMatches.length > 0) && (
        <CommandGroup heading={configHeading}>
          {source?.status === "error" && (
            <p className={NOTE_INFO_CLASS}>
              Couldn&apos;t load this lodge&apos;s saved config keys — you can
              still type a key above to insert it.
            </p>
          )}
          {source?.status === "ready" && entries.length === 0 && q === "" && (
            <p className={NOTE_INFO_CLASS}>
              Config keys are the lodge&apos;s own values — Wi-Fi code, door
              PIN, booking link. Add them under <strong>Admin → Lodges → the
              lodge → Lobby display → Config values</strong>, or type a key
              above to use it now.
            </p>
          )}
          {cfgMatches.map((e) => (
            <CommandItem
              key={e.key}
              value={`config:${e.key}`}
              className="items-baseline gap-2"
              onSelect={() => onInsert(displayConfigToken(e.key))}
            >
              {/* Decision 1: the saved value IS the row description, unmasked —
                  an author picks "the Wi-Fi one", not a remembered slug. */}
              <TokenRow token={displayConfigToken(e.key)}>
                Currently{" "}
                <code className="bg-muted rounded px-1">{e.value}</code>
              </TokenRow>
            </CommandItem>
          ))}
          {q === "" && (
            <p className="text-muted-foreground px-2 pb-1.5 pt-1 text-xs">
              Type above to insert a key that isn&apos;t saved yet —{" "}
              {DISPLAY_CONFIG_KEY_RULES}.
            </p>
          )}
        </CommandGroup>
      )}
      {showFreeRow &&
        (freeValid ? (
          <CommandGroup heading="Not in this lodge's config">
            {/* Decision 3: an unset key stays insertable, with the consequence
                stated up front — the exact placeholder the wall will show. */}
            <CommandItem
              value={`config-new:${typedKey}`}
              className="items-baseline gap-2"
              onSelect={() => onInsert(displayConfigToken(typedKey))}
            >
              <TokenRow token={displayConfigToken(typedKey)}>
                Insert as a new config key
              </TokenRow>
            </CommandItem>
            <p className={NOTE_WARN_CLASS}>
              No value saved
              {source?.lodgeName ? ` on ${source.lodgeName}` : ""}, so the board
              will show{" "}
              <code className="font-mono">
                {unsetDisplayConfigPlaceholder(typedKey)}
              </code>{" "}
              until the key is set under <strong>Admin → Lodges → the lodge →
              Lobby display → Config values</strong>.
            </p>
          </CommandGroup>
        ) : (
          <CommandGroup heading="Not a valid config key">
            {/* Inert rather than silently inserting something the renderer
                will never match. */}
            <CommandItem
              value="config-invalid"
              disabled
              className="items-baseline gap-2"
            >
              <TokenRow token={`{{config:${rawQuery.trim()}}}`}>
                Can&apos;t be inserted
              </TokenRow>
            </CommandItem>
            <p className={NOTE_WARN_CLASS}>
              A config key uses {DISPLAY_CONFIG_KEY_RULES}
              {suggestion ? (
                <>
                  {" "}
                  — try{" "}
                  <code className="bg-muted rounded px-1">{suggestion}</code>
                </>
              ) : null}
              .
            </p>
          </CommandGroup>
        ))}
    </>
  );
}

function CssTokenGroups({
  q,
  tokens,
  onInsert,
}: {
  q: string;
  tokens: ReturnType<typeof listDisplayCssInsertTokens>;
  onInsert: (text: string) => void;
}) {
  const matches = tokens.filter(
    (t) =>
      q === "" ||
      t.name.includes(q) ||
      t.insertText.includes(q) ||
      t.description.toLowerCase().includes(q)
  );
  const displayFamily = matches.filter((t) => t.family === "display");
  const brandFamily = matches.filter((t) => t.family === "brand");
  return (
    <>
      {displayFamily.length > 0 && (
        <CommandGroup heading="Display palette · always defined">
          {displayFamily.map((t) => (
            <CommandItem
              key={t.name}
              value={t.name}
              className="items-baseline gap-2"
              onSelect={() => onInsert(t.insertText)}
            >
              {/* The row reads the property name; Enter writes the usage. */}
              <TokenRow token={t.name}>{t.description}</TokenRow>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {brandFamily.length > 0 && (
        <CommandGroup heading="Club theme · follows the website">
          {brandFamily.map((t) => (
            <CommandItem
              key={t.name}
              value={t.name}
              className="items-baseline gap-2"
              onSelect={() => onInsert(t.insertText)}
            >
              <TokenRow token={t.name}>{t.description}</TokenRow>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  );
}
