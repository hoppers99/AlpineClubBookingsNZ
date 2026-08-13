"use client";

import {
  usePublishDiagnosticsViewState,
  type DiagnosticsViewState,
} from "./help-widget-context";

/**
 * Publish a SERVER component's applied view state into the help-widget context
 * (#2816, owner decision 13 Aug 2026: published applied state).
 *
 * Server pages parse their own query and apply defaults server-side, but hooks
 * are client-only — so a server page renders this with its POST-PARSE values as
 * props, and the widget reads them through the same channel client pages publish
 * on directly. Renders nothing.
 *
 * Publish what was APPLIED, never the raw address: the whole point of this
 * channel (over the widget's URL fallback) is that a malformed URL whose filters
 * the page rejected, or a default the page applied without a URL trace, is
 * reported as what the operator is actually looking at.
 *
 * PASS `{}` FOR "NOTHING WAS APPLIED", NOT `undefined`. `undefined` means "this
 * page publishes nothing at all", which returns the widget to its URL fallback —
 * re-reading the address a page that got this far has already decided not to
 * trust. An empty view suppresses the fallback and sends no `view` field.
 */
export function DiagnosticsViewStatePublisher({
  view,
}: {
  view: DiagnosticsViewState | undefined;
}) {
  usePublishDiagnosticsViewState(view);
  return null;
}
