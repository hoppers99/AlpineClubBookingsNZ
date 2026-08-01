import { getAppBaseUrl, sanitizeEmailHref } from "@/lib/app-url";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findBookingHref(html: string, fromIndex = 0) {
  const baseUrl = getAppBaseUrl().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    // `/bookings/consent/<token>` is a bearer action for recipients who may
    // not have a login. It must never be removed or rewritten as though it
    // were the authenticated `/bookings/<booking-id>` detail route.
    `href="${baseUrl}\\/bookings(?:\\/(?!consent(?:\\/|[?#]|$))[^"#?]*)?([?#][^"]*)?"`,
    "g",
  );
  pattern.lastIndex = fromIndex;
  return pattern.exec(html);
}

function findAnyBookingHref(html: string, fromIndex = 0) {
  const pattern = new RegExp(
    // Unauthorized final sanitation must also catch a legacy hard-coded app
    // origin and relative hrefs. Rewriting authorized built-ins stays on the
    // stricter current-origin matcher above; this wider matcher only removes.
    'href="(?:https?:\\/\\/[^/"?#]+)?\\/bookings(?:\\/(?!consent(?:\\/|[?#]|$))[^"#?]*)?([?#][^"]*)?"',
    "g",
  );
  pattern.lastIndex = fromIndex;
  return pattern.exec(html);
}

/** Whether HTML contains an authenticated booking-detail href (not a bearer action). */
export function hasBookingDetailHref(html: string): boolean {
  return findBookingHref(html) != null;
}

function removeBookingButtons(html: string): string {
  let next = html;
  let match = findAnyBookingHref(next);
  while (match) {
    const tableStart = next.lastIndexOf(
      '<table role="presentation" cellpadding="0" cellspacing="0"',
      match.index,
    );
    const tableEnd = next.indexOf("</table>", match.index);
    if (tableStart < 0 || tableEnd < 0) {
      next = `${next.slice(0, match.index)}${next.slice(match.index + match[0].length)}`;
    } else {
      next = `${next.slice(0, tableStart)}${next.slice(tableEnd + "</table>".length)}`;
    }
    match = findAnyBookingHref(next);
  }
  return next;
}

function appendBookingButton(html: string, bookingUrl: string): string {
  const safeUrl = escapeHtml(
    sanitizeEmailHref(bookingUrl, { baseUrl: getAppBaseUrl(), sameOrigin: true }),
  );
  const row = `
          <!-- Canonical booking detail link -->
          <tr>
            <td style="background-color: #ffffff; padding: 0 32px 20px; border-left: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0;">
                <tr><td style="background-color: #e7b83f; border-radius: 6px;"><a href="${safeUrl}" target="_blank" style="display: inline-block; padding: 12px 28px; color: #1f2937; text-decoration: none; font-weight: 700; font-size: 14px;">View Booking</a></td></tr>
              </table>
            </td>
          </tr>
`;
  return html.includes("<!-- Footer -->")
    ? html.replace("<!-- Footer -->", `${row}          <!-- Footer -->`)
    : `${html}${row}`;
}

/**
 * Rewrite built-in booking CTAs to the authorized canonical detail URL.
 * Public/non-login recipients lose only authenticated `/bookings` buttons;
 * bearer payment/respond/consent links use different paths and are untouched.
 */
export function applyBookingDetailLinkToBuiltInHtml(
  html: string,
  bookingUrl: string | null,
): string {
  if (!bookingUrl) return removeBookingButtons(html);

  const safeUrl = escapeHtml(
    sanitizeEmailHref(bookingUrl, { baseUrl: getAppBaseUrl(), sameOrigin: true }),
  );
  let next = html;
  let replaced = false;
  let match = findBookingHref(next);
  while (match) {
    // A booking-detail CTA can itself target an action on the page (for
    // example the member-guest consent card at `#consent`). Canonicalize only
    // the booking path; preserve the query/fragment suffix byte-for-byte.
    const suffix = match[1] ?? "";
    const replacement = `href="${safeUrl}${suffix}"`;
    next = `${next.slice(0, match.index)}${replacement}${next.slice(match.index + match[0].length)}`;
    replaced = true;
    match = findBookingHref(next, match.index + replacement.length);
  }
  return replaced ? next : appendBookingButton(next, bookingUrl);
}

/**
 * Finalize the rendered delivery copy without ever mutating stored override
 * source. An authorized override remains byte-for-byte unchanged; an
 * unauthorized override loses stale/admin-authored authenticated booking
 * hrefs at this last outbound boundary. Bearer consent links remain intact.
 */
export function finalizeBookingEmailHtml(params: {
  html: string;
  bookingUrl: string | null;
  bookingScoped: boolean;
  bodyOverrideApplied: boolean;
}): string {
  if (!params.bookingScoped) return params.html;
  if (params.bodyOverrideApplied) {
    return params.bookingUrl ? params.html : removeBookingButtons(params.html);
  }
  return applyBookingDetailLinkToBuiltInHtml(params.html, params.bookingUrl);
}
