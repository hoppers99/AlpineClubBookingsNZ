// E2E bootstrap: give the stack the persisted club identity the product seed
// used to write unconditionally.
//
// `prisma/seed.ts` now writes `ClubIdentitySettings` only when the effective
// config provenance is a real primary `config/club.json` (#237, epic #213 D16 —
// the boot self-heal refuses that write for the same reason, and the seed used
// to do it anyway). `config/club.json` is gitignored, so in CI the provenance is
// "example" and the seed correctly writes nothing.
//
// That is right for a product install and wrong for this suite, which needs a
// named club the way a real deployment has one:
//
//   - `e2e/club-identity-smoke.spec.ts` reads the persisted override, renames
//     the club and restores what it found. With no row at all it would be
//     restoring an absence by saving an empty string, which is a different
//     thing.
//   - the club-config readiness check is DB-first, so with no row every setup
//     surface reports the installation "blocked" — the wizard specs would then
//     exercise a stack in an unusual state rather than the ordinary one.
//
// Writing it HERE rather than in the product seed is the whole point: this is a
// test fixture, declared as one, in a file the suite owns.
//
// IT REPRODUCES THE OLD SEED WRITE EXACTLY — same fields, same source, same
// normalisation, same create-only semantics — so the E2E database is
// byte-identical to the one this suite ran against before #237, and any E2E
// movement in this PR is about the wizard rather than about the fixture. Keep
// it that way: if the seed's own identity write changes shape, change this with
// it.
//
// Run by scripts/e2e-stack.sh after seeding, before the app starts.
import { PrismaClient } from "@prisma/client";
import { clubConfig } from "../../src/config/club";
import { createPrismaPgAdapter } from "../../src/lib/prisma-adapter";

const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });

async function main() {
  // Create-only by lookup rather than `upsert(update: {})`, so the log can say
  // which of the two happened — a stack where a spec has already renamed the
  // club is a legitimate state, not a failure, and silently no-opping on it
  // makes a re-run impossible to read.
  const existing = await prisma.clubIdentitySettings.findUnique({
    where: { id: "default" },
    select: { name: true },
  });
  if (existing) {
    console.log(
      `Club identity already present (${existing.name}) — left untouched.`,
    );
    return;
  }

  await prisma.clubIdentitySettings.create({
    data: {
      id: "default",
      name: clubConfig.name,
      shortName: clubConfig.shortName ?? null,
      hutLeaderLabel: clubConfig.hutLeaderLabel ?? null,
      facebookUrl: clubConfig.socialLinks?.facebook?.trim() || null,
    },
  });
  console.log(`E2E club identity seeded: ${clubConfig.name}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
