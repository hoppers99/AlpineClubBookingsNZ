import "server-only";

import { cookies } from "next/headers";
import {
  FAMILY_INVITE_RETURN_COOKIE,
  getFamilyInviteReturnPath,
} from "@/lib/family-invite-return-address";

/**
 * Read the #2827 family-invite return address out of the request's cookies, or
 * null when there is not a valid one.
 *
 * Split out of `family-invite-return-address.ts` on purpose: that module is
 * imported by `src/proxy.ts`, which runs in the middleware runtime, and
 * `next/headers` belongs to the render/route-handler runtime. Keeping the
 * `cookies()` read here is what lets the proxy share the cookie name, the shape
 * guard and the serialiser without dragging a request-scoped API into the
 * middleware bundle.
 *
 * Every caller is request-scoped (three server components and one route
 * handler), so `cookies()` cannot throw here; there is deliberately no
 * try/catch swallowing that, because a call from outside a request scope is a
 * bug worth seeing rather than a silent fall back to the default landing.
 */
export async function readFamilyInviteReturnAddress(): Promise<string | null> {
  const cookieStore = await cookies();

  return getFamilyInviteReturnPath(
    cookieStore.get(FAMILY_INVITE_RETURN_COOKIE)?.value ?? null,
  );
}
