import { NextRequest, NextResponse } from "next/server";
import { readFamilyInviteReturnAddress } from "@/lib/family-invite-return-address-cookie";
import { serialiseFamilyInviteReturnCookie } from "@/lib/family-invite-return-address";
import { resolvePostLoginLandingPath } from "@/lib/post-login-landing";
import { requireActiveSession } from "@/lib/session-guards";

// Post-auth landing resolver (#2090). The credential and magic-link login
// clients call this after a successful sign-in — once the session cookie
// exists — to learn where to navigate, honouring the member's landing
// preference and admin role default. Precedence and open-redirect safety live
// entirely in resolvePostLoginLandingPath; this route only supplies the
// session-derived preference + permission matrix (both refreshed per request by
// the auth jwt callback) and the caller's explicit callbackUrl, if any.
// A guard failure (deactivated member, forced password change) is harmless
// here: the login client falls back to its sanitized redirect and the
// change-password/self-heal flows take over.
export async function GET(req: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }
  const { user } = guard.session;

  const explicitCallbackUrl = req.nextUrl.searchParams.get("callbackUrl");
  // #2827: the family-invite return address, carried in an HttpOnly cookie so the
  // invite token never has to be rendered into the sign-in link's href. This route
  // is the TERMINAL consumer for the credential and magic-link flows — the client
  // navigates to whatever it answers — so it is also the one place in the four
  // resolution sites that can clear the cookie, `cookies()` being writable in a
  // route handler and not in a server component.
  const privateReturnPath = await readFamilyInviteReturnAddress();
  const path = resolvePostLoginLandingPath({
    explicitCallbackUrl,
    privateReturnPath,
    landingPreference: user.postLoginLanding,
    permissionInput: {
      adminPermissionMatrix: user.adminPermissionMatrix,
    },
  });

  const response = NextResponse.json({ path });

  // Cleared whenever a valid address was present, not only when it won: an
  // explicit callbackUrl outranks it, and leaving it behind would then steer the
  // member's NEXT sign-in somewhere they did not ask for. Expiry is a past-dated
  // overwrite with the same attributes, never a bare delete.
  if (privateReturnPath) {
    response.headers.append(
      "Set-Cookie",
      serialiseFamilyInviteReturnCookie("", 0),
    );
  }

  return response;
}
