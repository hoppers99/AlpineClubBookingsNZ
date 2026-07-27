"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useConfirm } from "@/components/confirm-dialog";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";
import {
  BUILT_IN_DISPLAY_LAYOUTS,
  BUILT_IN_DISPLAY_TEMPLATES,
} from "@/lib/lodge-display/built-in-seeds";

// "Restore built-in boards" + the honest empty state for the Templates gallery
// (#2247). The behaviour lives here rather than in `templates/page.tsx` so that
// (already large) page takes a small diff — #2248 rewrites it next — and so the
// empty-state reasoning can be unit-tested on its own.
//
// The built-in boards are created ONLY by the database seed, and no deploy or
// upgrade path re-runs the seed, so a club whose database predates the
// lobby-display feature has no `builtin-*` rows at all: the gallery is empty,
// says nothing, and offers no way out. This is the way out.

const LAYOUT_COUNT = BUILT_IN_DISPLAY_LAYOUTS.length;
const TEMPLATE_COUNT = BUILT_IN_DISPLAY_TEMPLATES.length;

/**
 * Why the templates list is empty, as far as the BROWSER can honestly tell.
 *
 * The three causes named in #2247 are told apart by the status the templates
 * GET returns, because that response is the only evidence this page has:
 *  • `module-off` — 404. The proxy 404s all of `/api/admin/display/*` while the
 *    `lobbyDisplay` module is off (and it is off by default). Normally the PAGE
 *    404s with it, so reaching this state means the flag went off under an
 *    already-open tab. The copy says "looks switched off" rather than asserting
 *    it, because a 404 is also what a genuinely missing route would return.
 *  • `forbidden` — 403 from the route's `lodge:view` guard. The browser is told
 *    only that the request was refused, never WHICH permission was missing, so
 *    the copy names the likely cause and says how it was inferred instead of
 *    asserting a role state it cannot read.
 *  • `empty` — a successful but genuinely empty list. This is the never-seeded
 *    case the restore action fixes.
 *  • `error` — anything else, named as unknown rather than blamed on a guess.
 */
export type TemplatesLoadState =
  | "loading"
  | "empty"
  | "module-off"
  | "forbidden"
  | "error";

/** Map the templates GET status to the empty-state cause. */
export function templatesLoadStateForStatus(status: number): TemplatesLoadState {
  if (status === 404) return "module-off";
  if (status === 403) return "forbidden";
  if (status >= 200 && status < 300) return "empty";
  return "error";
}

/**
 * The gallery's empty state. Rendered only when the list came back with nothing
 * in it; `state` says which of the causes above produced that.
 */
export function DisplayTemplatesEmptyState({
  state,
}: {
  state: TemplatesLoadState;
}) {
  if (state === "loading") return null;

  if (state === "module-off") {
    return (
      <EmptyStateBox heading="The Lobby TV display module looks switched off.">
        The templates list returned <strong>404 Not found</strong>, which is how
        every <code className="bg-muted rounded px-1">/admin/display</code>{" "}
        address answers while the module is off — and it is off by default. Turn{" "}
        <strong>Lobby TV display</strong> on under{" "}
        <strong>Admin → Setup → Modules</strong>, then reload this page.
      </EmptyStateBox>
    );
  }

  if (state === "forbidden") {
    return (
      <EmptyStateBox heading="Your admin role can’t see the display templates.">
        The templates list returned <strong>403 Forbidden</strong>. That is what
        a missing <strong>lodge view</strong> permission looks like from here —
        the browser is told only that the request was refused, not which
        permission was missing — so if your role does have lodge access, ask an
        administrator to check the server log for the real reason. Templates are
        club-wide, so this is never about which lodge you can see.
      </EmptyStateBox>
    );
  }

  if (state === "error") {
    return (
      <EmptyStateBox heading="The templates list could not be loaded.">
        The server did not say why. Reload the page; if it keeps happening, the
        server log for{" "}
        <code className="bg-muted rounded px-1">
          /api/admin/display/templates
        </code>{" "}
        will have the reason.
      </EmptyStateBox>
    );
  }

  // state === "empty": the list loaded fine and there is genuinely nothing in it.
  return (
    <EmptyStateBox heading="No display templates yet — not even the built-in boards.">
      The {TEMPLATE_COUNT} built-in boards are created by the database seed, and
      upgrading the app does not re-run the seed — so a club whose database
      predates the lobby display starts with none. Use{" "}
      <strong>Restore built-in boards</strong> below to create them.
    </EmptyStateBox>
  );
}

function EmptyStateBox({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <div className="text-muted-foreground space-y-2 text-sm">
      <p className="text-foreground font-medium">{heading}</p>
      <p>{children}</p>
    </div>
  );
}

/**
 * Runs the convergent built-in re-seed behind an explicit confirmation.
 *
 * The confirmation is not ceremony: `ensureBuiltInDisplays` REWRITES every
 * `builtin-*` row to its shipped definition, so an operator who edited a
 * built-in in place loses that edit. The dialog states that before it runs
 * (#2247), and the server audits the action.
 *
 * Returned as a hook rather than a button so the button itself stays a
 * `ViewOnlyActionButton` in `templates/page.tsx`, under that page's single
 * view-only banner (the same-file coverage rule in
 * `view-only-banner-contract.test.ts`).
 */
export function useRestoreBuiltInBoards(options: {
  /** `restored` is true only when the built-ins were actually re-seeded. */
  onResult: (message: string, restored: boolean) => void;
}): { run: () => Promise<void>; running: boolean; confirmDialog: ReactNode } {
  const { confirm, confirmDialog } = useConfirm();
  const [running, setRunning] = useState(false);
  const { onResult } = options;

  const run = useCallback(async () => {
    const confirmed = await confirm({
      title: "Restore the built-in boards?",
      description:
        `This rewrites the ${LAYOUT_COUNT} built-in layouts and ` +
        `${TEMPLATE_COUNT} built-in templates back to the designs that ship ` +
        `with the app. Missing ones are created; any that already exist are ` +
        `OVERWRITTEN, so changes made to a built-in in place are lost. Your ` +
        `own layouts and templates are not touched, and screens stay bound to ` +
        `whatever they already show.`,
      confirmLabel: "Restore built-in boards",
      destructive: true,
    });
    if (!confirmed) return;

    setRunning(true);
    const response = await fetch("/api/admin/display/built-ins/restore", {
      method: "POST",
    }).catch(() => null);
    setRunning(false);

    if (!response) {
      onResult(
        "Could not reach the server to restore the built-in boards.",
        false
      );
      return;
    }
    if (response.status === 403) {
      onResult(ADMIN_FORBIDDEN_SAVE_REASON, false);
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      onResult(body?.error ?? "Could not restore the built-in boards.", false);
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { layouts?: number; templates?: number }
      | null;
    onResult(
      `Restored the built-in boards — ${body?.layouts ?? LAYOUT_COUNT} ` +
        `layouts and ${body?.templates ?? TEMPLATE_COUNT} templates now match ` +
        `the designs that ship with the app.`,
      true
    );
  }, [confirm, onResult]);

  return { run, running, confirmDialog };
}
