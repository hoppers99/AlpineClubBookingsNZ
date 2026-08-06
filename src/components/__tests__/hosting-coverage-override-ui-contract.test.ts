import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(path, "utf8").replaceAll("\\", "/");
}

describe("officer hosting-coverage override UI authority (#2576 §7, §11)", () => {
  it("keeps the shared browser contract free of server-only dependencies", () => {
    const client = source("src/lib/hosting-coverage-override-client.ts");
    expect(client).not.toMatch(
      /(?:from\s+|import\s*)["'](?:@prisma\/client|node:crypto|server-only)["']/,
    );
  });

  it("passes cancellation authority from the exact booking-management role", () => {
    const page = source("src/app/(authenticated)/bookings/[id]/page.tsx");
    expect(page).toContain(
      'canOverrideHostingCoverage={viewerAuthorizationRole === "ADMIN"}',
    );
    expect(page).toContain(
      'canChooseMemberEmail={viewerAuthorizationRole === "ADMIN"}',
    );

    const cancel = source("src/components/cancel-booking-button.tsx");
    expect(cancel).toContain("canOverrideHostingCoverage = false");
    expect(cancel).toContain("canOverrideHostingCoverage\n          ?");
    expect(cancel).not.toMatch(
      /const canOverrideHostingCoverage\s*=\s*canChooseMemberEmail/,
    );
  });

  it("gates edit details on the server-serialised officer role", () => {
    const edit = source("src/components/edit-booking-panel.tsx");
    expect(edit).toContain('const actingAsAdmin = booking.viewerRole === "ADMIN"');
    expect(edit).toContain(
      "actingAsAdmin\n          ? readHostingCoverageOverridePrompt(data)",
    );
    expect(edit).toContain("actingAsAdmin && activeHostingOverrideState");
  });

  it("does not add an override producer to member self-removal or draft confirmation", () => {
    const guestControls = source("src/components/self-remove-from-booking-card.tsx");
    const confirmDraft = source("src/components/confirm-draft-button.tsx");
    expect(guestControls).not.toContain("hostingCoverageOverride");
    // DRAFT confirmation only adds attendance/coverage and this button is not an
    // officer edit surface, so a same-owner stranding prompt is unreachable here.
    expect(confirmDraft).not.toContain("hostingCoverageOverride");
  });
});
