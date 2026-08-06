import { type APIRequestContext, expect } from "@playwright/test";

export type BedAllocationSettingsSnapshot = {
  lodgeId: string;
  autoAllocationEnabled: boolean;
  allocationPriorityOrder: string[];
};

async function resolveSingleActiveLodgeId(
  request: APIRequestContext,
): Promise<string> {
  const response = await request.get("/api/lodges");
  expect(response.ok(), `GET /api/lodges (${response.status()})`).toBeTruthy();
  const body = (await response.json()) as {
    lodges: Array<{ id: string; name: string }>;
  };
  expect(
    body.lodges,
    `single-lodge E2E settings helper received ${body.lodges.length} lodges`,
  ).toHaveLength(1);
  return body.lodges[0]!.id;
}

async function getSingleLodgeBedAllocationSettings(
  request: APIRequestContext,
): Promise<BedAllocationSettingsSnapshot> {
  const lodgeId = await resolveSingleActiveLodgeId(request);
  const response = await request.get(
    `/api/admin/bed-allocation/settings?lodgeId=${encodeURIComponent(lodgeId)}`,
  );
  expect(
    response.ok(),
    `GET bed-allocation settings (${response.status()})`,
  ).toBeTruthy();
  const body = (await response.json()) as {
    settings: {
      autoAllocationEnabled: boolean;
      allocationPriorityOrder: string[];
      authoritativeLodgeId: string | null;
    };
  };
  expect(body.settings.authoritativeLodgeId).toBe(lodgeId);
  expect(Array.isArray(body.settings.allocationPriorityOrder)).toBe(true);
  return {
    lodgeId,
    autoAllocationEnabled: body.settings.autoAllocationEnabled,
    allocationPriorityOrder: [...body.settings.allocationPriorityOrder],
  };
}

export async function setBedAllocationSettings(
  request: APIRequestContext,
  settings: BedAllocationSettingsSnapshot,
): Promise<void> {
  const response = await request.put("/api/admin/bed-allocation/settings", {
    data: settings,
  });
  expect(
    response.ok(),
    `PUT bed-allocation settings (${response.status()})`,
  ).toBeTruthy();
}

export async function overrideSingleLodgeAutoAllocation(
  request: APIRequestContext,
  autoAllocationEnabled: boolean,
): Promise<BedAllocationSettingsSnapshot> {
  const previous = await getSingleLodgeBedAllocationSettings(request);
  await setBedAllocationSettings(request, {
    ...previous,
    autoAllocationEnabled,
  });
  return previous;
}
