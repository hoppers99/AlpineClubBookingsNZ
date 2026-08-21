import "server-only";

import { cookies } from "next/headers";
import { FAMILY_INVITE_RETURN_COOKIE } from "@/lib/family-invite-return-address";

/**
 * The raw #2827 family-invite return-address cookie value on this request, or
 * null when there is not one.
 *
 * **Raw on purpose, since #2974.** It used to parse and return a path, which
 * meant a caller could obtain a landing without presenting the tab-binding
 * nonce. Handing back the untouched value instead forces every consumption site
 * through `resolvePostLoginLandingPath()`, which pairs it with the nonce the
 * caller was given and refuses it otherwise. The value is never trusted between
 * here and there — `matchFamilyInviteReturnCookie()` re-validates both halves
 * against their anchored patterns.
 *
 * Split out of `family-invite-return-address.ts` on purpose: that module is
 * imported by `src/proxy.ts`, which runs in the middleware runtime, and
 * `next/headers` belongs to the render/route-handler runtime. Keeping the
 * `cookies()` read here is what lets the proxy share the cookie name, the shape
 * guards and the serialiser without dragging a request-scoped API into the
 * middleware bundle.
 *
 * Every caller is request-scoped (three server components and one route
 * handler), so `cookies()` cannot throw here; there is deliberately no
 * try/catch swallowing that, because a call from outside a request scope is a
 * bug worth seeing rather than a silent fall back to the default landing.
 */
export async function readFamilyInviteReturnCookieValue(): Promise<
  string | null
> {
  const cookieStore = await cookies();

  return cookieStore.get(FAMILY_INVITE_RETURN_COOKIE)?.value ?? null;
}
