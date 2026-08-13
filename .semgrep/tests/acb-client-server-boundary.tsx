"use client";

// Fixtures for `.semgrep/rules/acb-client-server-boundary.yml`. Lines marked
// `ruleid:` MUST be reported and lines marked `ok:` MUST NOT be — the test fails
// either way round, so this file is what stops the rule quietly becoming a
// no-op or quietly becoming noise.
//
// The `Static analysis gate` job runs these on every pull request. To run them
// yourself (the same pinned image CI uses):
//
//   docker run --rm -v "$PWD:/src:ro" -w /src semgrep/semgrep:1.161.0 \
//     semgrep --test --config .semgrep/rules .semgrep/tests --metrics=off
//
// This directory is excluded from the CI scan (see the rule's `paths.exclude`
// and the `--exclude` flags on the `Static analysis gate` step), because every
// violation below is deliberate.

// ruleid: acb-client-server-boundary
import { prisma } from "@/lib/prisma";
// ruleid: acb-client-server-boundary
import { prisma as siblingPrisma } from "./prisma";
// ruleid: acb-client-server-boundary
import { auth } from "@/lib/auth";
// ruleid: acb-client-server-boundary
import "server-only";
// ruleid: acb-client-server-boundary
import { cookies } from "next/headers";
// ruleid: acb-client-server-boundary
import * as fs from "node:fs";
// ruleid: acb-client-server-boundary
import { readFile } from "fs/promises";
// ruleid: acb-client-server-boundary
import { spawn } from "child_process";

// A type-only import is erased before the bundle exists, so it cannot leak
// anything and must not be reported. This is the shape the one real occurrence
// in `src/` uses today.
// ok: acb-client-server-boundary
import type { PrismaClient } from "@/lib/prisma";
// ok: acb-client-server-boundary
import type { Session } from "@/lib/auth";

// Ordinary client-side imports.
// ok: acb-client-server-boundary
import { useState } from "react";
// ok: acb-client-server-boundary
import { formatNZDate } from "@/lib/nzst-date";
// ok: acb-client-server-boundary
import { Button } from "@/components/ui/button";
// A module whose NAME merely contains one of the banned words is not the banned
// module — the pattern is anchored, so this must not be reported.
// ok: acb-client-server-boundary
import { describePrismaError } from "@/lib/prisma-error-shape";
// ok: acb-client-server-boundary
import { useAuthState } from "@/lib/auth-client-state";

export function Fixture() {
  const [n] = useState(0);
  return (
    <Button>
      {n} {String(prisma)} {String(siblingPrisma)} {String(auth)} {String(cookies)}
      {String(fs)} {String(readFile)} {String(spawn)} {formatNZDate(new Date())}
      {String(describePrismaError)} {String(useAuthState)}
      {String({} as PrismaClient)} {String({} as Session)}
    </Button>
  );
}
