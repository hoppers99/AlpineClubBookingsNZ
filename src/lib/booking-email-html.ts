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
    `href="${baseUrl}\\/bookings(?:\\/(?!consent(?:\\/|[?#]|$))[^"#?]*)?(?:[?#][^"]*)?"`,
    "g",
  );
  pattern.lastIndex = fromIndex;
  return pattern.exec(html);
}

function removeBookingButtons(html: string): string {
  let next = html;
  let match = findBookingHref(next);
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
    match = findBookingHref(next);
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
    next = `${next.slice(0, match.index)}href="${safeUrl}"${next.slice(match.index + match[0].length)}`;
    replaced = true;
    match = findBookingHref(next, match.index + safeUrl.length);
  }
  return replaced ? next : appendBookingButton(next, bookingUrl);
}

/** Stored body overrides remain an explicit admin-authored contract. */
export function finalizeBookingEmailHtml(params: {
  html: string;
  bookingUrl: string | null;
  bookingScoped: boolean;
  bodyOverrideApplied: boolean;
}): string {
  if (!params.bookingScoped || params.bodyOverrideApplied) return params.html;
  return applyBookingDetailLinkToBuiltInHtml(params.html, params.bookingUrl);
}
