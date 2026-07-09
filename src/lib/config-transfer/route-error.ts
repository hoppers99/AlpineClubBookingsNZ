import { NextResponse } from "next/server";

import logger from "@/lib/logger";
import { ConfigTransferBundleError } from "./bundle";

// Shared error → response mapping for the config-transfer admin routes. A bad
// bundle is a 400 with its message; anything else is logged server-side (so it
// shows in the app logs) and returned as a sanitised 500 message, rather than a
// bare unhandled 500 that surfaces to the admin as an opaque "failed".
export function configTransferErrorResponse(
  context: string,
  error: unknown,
): NextResponse {
  if (error instanceof ConfigTransferBundleError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  logger.error({ err: error }, `config-transfer ${context} failed`);
  const detail =
    error instanceof Error && error.message
      ? error.message.replace(/\s+/g, " ").trim().slice(0, 400)
      : "Unexpected error.";
  return NextResponse.json(
    { error: `${context} failed: ${detail}` },
    { status: 500 },
  );
}
