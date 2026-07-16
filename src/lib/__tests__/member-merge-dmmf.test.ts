import { readFileSync } from "fs";
import { join } from "path";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  MEMBER_MERGE_RELATION_SPECS,
  diffRelationSpecCoverage,
  memberRelationNamesFromDmmf,
  parseMemberRelationOwnerKeys,
} from "@/lib/member-merge";

const schemaText = readFileSync(
  join(process.cwd(), "prisma", "schema.prisma"),
  "utf8",
);

const specKeys = MEMBER_MERGE_RELATION_SPECS.map((s) => s.key);

describe("member-merge relation classification completeness", () => {
  it("classifies every Member FK-owning relation exactly once (no missing, no extra)", () => {
    const ownerKeys = parseMemberRelationOwnerKeys(schemaText);
    const { missing, extra } = diffRelationSpecCoverage(ownerKeys, specKeys);

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("has no duplicate spec keys (each relation in exactly one bucket)", () => {
    const seen = new Set<string>();
    for (const key of specKeys) {
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("FAILS when the schema grows an unclassified Member relation (fixture proof)", () => {
    const injected = `${schemaText}
model FutureThing {
  id        String @id @default(cuid())
  memberId  String
  member    Member @relation("FutureThingMember", fields: [memberId], references: [id], onDelete: Cascade)
}
`;
    const ownerKeys = parseMemberRelationOwnerKeys(injected);
    const { missing } = diffRelationSpecCoverage(ownerKeys, specKeys);

    expect(missing).toContain("FutureThing.member");
  });

  it("FAILS when a spec key no longer exists in the schema (fixture proof)", () => {
    const ownerKeys = parseMemberRelationOwnerKeys(schemaText);
    const { extra } = diffRelationSpecCoverage(ownerKeys, [
      ...specKeys,
      "GhostModel.member",
    ]);

    expect(extra).toContain("GhostModel.member");
  });

  it("cross-checks against the runtime DMMF: the trimmed DMMF exposes Member relations", () => {
    const relNames = memberRelationNamesFromDmmf(
      Prisma.dmmf.datamodel.models as unknown as {
        name: string;
        fields: { type: string; relationName?: string }[];
      }[],
    );
    expect(relNames.size).toBeGreaterThan(0);
  });

  it("every spec key names a real DMMF model.field whose type is Member (catches typos)", () => {
    const modelByName = new Map(
      Prisma.dmmf.datamodel.models.map((m) => [m.name, m]),
    );
    for (const s of MEMBER_MERGE_RELATION_SPECS) {
      const model = modelByName.get(s.model);
      expect(model, `unknown model ${s.model}`).toBeDefined();
      const field = model?.fields.find((f) => f.name === s.field);
      expect(field, `unknown field ${s.key}`).toBeDefined();
      expect(field?.type, `${s.key} is not a Member relation`).toBe("Member");
    }
  });
});
