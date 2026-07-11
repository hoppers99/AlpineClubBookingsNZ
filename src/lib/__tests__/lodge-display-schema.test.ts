import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
} from "@/config/modules";
import { featureFlagsSchema } from "@/config/schema";
import { SINGLETONS } from "@/lib/config-transfer/categories/club-settings";

// Issue #26 (LTV-001): the lobby-display data model and module flag exist and
// the key is registered at every module-key enumeration point, defaulting OFF
// so no club sees the surface without opting in.

describe("lobbyDisplay module registration (issue #26)", () => {
  it("registers the module key, defaulting OFF", () => {
    expect(MODULE_KEYS).toContain("lobbyDisplay");
    expect(DEFAULT_MODULE_SETTINGS.lobbyDisplay).toBe(false);
    expect(MODULE_DEFINITIONS.lobbyDisplay.label).toBe("Lobby TV display");
  });

  it("is part of the feature-flag schema and the config-transfer field list", () => {
    const allOff = Object.fromEntries(MODULE_KEYS.map((k) => [k, false]));
    expect(featureFlagsSchema.parse(allOff).lobbyDisplay).toBe(false);

    const moduleSpec = SINGLETONS.find(
      (s) => s.entity === "club-module-settings",
    );
    expect(moduleSpec?.fields).toContain("lobbyDisplay");
  });
});

describe("lobby-display Prisma models (issue #26)", () => {
  it("generates client types for the new models (type-level smoke)", () => {
    const device: Prisma.LodgeDisplayDeviceUncheckedCreateInput = {
      lodgeId: "lodge-1",
      name: "Lobby TV",
    };
    const template: Prisma.DisplayTemplateCreateInput = {
      key: "everyday-board",
      name: "Everyday board",
      source: "CUSTOM",
      definition: {},
    };

    expect(device.name).toBe("Lobby TV");
    expect(template.source).toBe("CUSTOM");

    // AC7: no plaintext token column exists — only tokenHash.
    const bad: Prisma.LodgeDisplayDeviceUncheckedCreateInput = {
      lodgeId: "lodge-1",
      name: "Lobby TV",
      // @ts-expect-error — a plaintext `token` column must not exist
      token: "raw-token-value",
    };
    expect(bad).toBeDefined();
  });
});
