import fs from "node:fs";
import path from "node:path";
import type { Page, Request as PlaywrightRequest, Route } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import {
  E2E_BOOKING_CREATE_CENSUS,
  bookingCreateIsolation,
  withBookingCreateClientIp,
} from "../../../e2e/helpers/booking-create-client-ip";

const E2E_ROOT = path.join(process.cwd(), "e2e");

function e2eTypeScriptFiles(directory = E2E_ROOT): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return e2eTypeScriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

function repoRelative(file: string): string {
  return path.relative(process.cwd(), file).replaceAll("\\", "/");
}

function source(relativeFile: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativeFile), "utf8");
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

describe("E2E booking-create retry isolation (#2599)", () => {
  it("allocates a stable valid private IP per spec attempt without collisions", () => {
    const addresses = E2E_BOOKING_CREATE_CENSUS.flatMap((entry) =>
      [0, 1, 2].map((retry) => bookingCreateIsolation(entry.key, retry).clientIp),
    );

    expect(new Set(addresses).size).toBe(addresses.length);
    expect(addresses.every(isPrivateIpv4)).toBe(true);

    const stable = bookingCreateIsolation("stripe-success", 1);
    expect(bookingCreateIsolation("stripe-success", 1)).toEqual(stable);
    expect(stable.headers).toEqual({ "x-forwarded-for": stable.clientIp });
    expect(bookingCreateIsolation("stripe-success", 0).clientIp).not.toBe(
      stable.clientIp,
    );
    expect(bookingCreateIsolation("stripe-decline", 1).clientIp).not.toBe(
      stable.clientIp,
    );
  });

  it("stays outside the reserved login and whole-lodge submission ranges", () => {
    for (const entry of E2E_BOOKING_CREATE_CENSUS) {
      const address = bookingCreateIsolation(entry.key, 0).clientIp;
      expect(address).toMatch(/^10\.240\./);
      expect(address).not.toMatch(/^10\.99\./);
      expect(address).not.toMatch(/^10\.77\.1\./);
    }

    const authSource = source("e2e/helpers/auth.ts");
    expect(authSource).toContain("return `10.99.");
    const wholeLodgeSource = source("e2e/whole-lodge-request.spec.ts");
    expect(wholeLodgeSource).toContain('clear: "10.77.1.1"');
    expect(wholeLodgeSource).toContain('full: "10.77.1.2"');
    expect(wholeLodgeSource).toContain('held: "10.77.1.3"');
  });

  it("fails closed for an invalid retry dimension", () => {
    expect(() => bookingCreateIsolation("stripe-success", -1)).toThrow(
      /integer from 0 to 253/,
    );
    expect(() => bookingCreateIsolation("stripe-success", 1.5)).toThrow(
      /integer from 0 to 253/,
    );
    expect(() => bookingCreateIsolation("stripe-success", 254)).toThrow(
      /integer from 0 to 253/,
    );
  });

  it("adds the header only to the exact browser booking-create request", async () => {
    let handler: Parameters<Page["route"]>[1] | undefined;
    const bookingRequest = {
      method: () => "POST",
      url: () => "http://127.0.0.1:3000/api/bookings",
      headers: () => ({ cookie: "session=***" }),
    };
    const page = {
      route: vi.fn(async (_pattern, registered) => {
        handler = registered;
      }),
      waitForRequest: vi.fn(
        async (predicate: (request: typeof bookingRequest) => boolean) => {
          expect(predicate(bookingRequest)).toBe(true);
          return bookingRequest;
        },
      ),
      unroute: vi.fn(async () => undefined),
    } as unknown as Page;
    const continueRequest = vi.fn(async () => undefined);
    const isolation = bookingCreateIsolation("stripe-success", 2);

    await withBookingCreateClientIp(page, isolation, async () => {
      expect(handler).toBeTypeOf("function");
      await handler!(
        {
          request: () => ({
            ...bookingRequest,
          }),
          continue: continueRequest,
        } as unknown as Route,
        {} as PlaywrightRequest,
      );
    });

    expect(page.route).toHaveBeenCalledWith("**/api/bookings", expect.any(Function));
    expect(continueRequest).toHaveBeenCalledWith({
      headers: {
        cookie: "session=***",
        "x-forwarded-for": isolation.clientIp,
      },
    });
    expect(page.unroute).toHaveBeenCalledWith(
      "**/api/bookings",
      expect.any(Function),
    );
  });

  it("pins the complete 27-request census and every explicit isolation key", () => {
    expect(E2E_BOOKING_CREATE_CENSUS).toHaveLength(24);
    expect(
      E2E_BOOKING_CREATE_CENSUS.reduce(
        (total, entry) => total + ("requestsPerAttempt" in entry ? entry.requestsPerAttempt : 1),
        0,
      ),
    ).toBe(27);
    expect(
      E2E_BOOKING_CREATE_CENSUS.every(
        (entry) => entry.classification === "isolated-setup",
      ),
    ).toBe(true);

    const registeredKeys = E2E_BOOKING_CREATE_CENSUS.map((entry) => entry.key).sort();
    const usedKeys = e2eTypeScriptFiles()
      .filter((file) => !file.endsWith("booking-create-client-ip.ts"))
      .flatMap((file) =>
        [...fs.readFileSync(file, "utf8").matchAll(/bookingCreateIsolation\(\s*"([^"]+)"/g)].map(
          (match) => match[1],
        ),
      )
      .sort();
    expect(usedKeys).toEqual(registeredKeys);

    for (const entry of E2E_BOOKING_CREATE_CENSUS) {
      expect(source(entry.file), `${entry.key} must be owned by ${entry.file}`).toMatch(
        new RegExp(`bookingCreateIsolation\\(\\s*"${entry.key}"`),
      );
    }
  });

  it("pins every direct APIRequestContext POST call site", () => {
    const expected = new Map<string, number>([
      ["e2e/admin-retroactive-booking.spec.ts", 1],
      ["e2e/adult-member-hosting.spec.ts", 3],
      ["e2e/double-bed-sharing.spec.ts", 1],
      ["e2e/member-guest-consent.spec.ts", 1],
      ["e2e/multi-lodge/member-guest-edit-path.spec.ts", 1],
      ["e2e/waitlist.spec.ts", 2],
      ["e2e/whole-lodge-request.spec.ts", 1],
    ]);
    const actual = new Map<string, number>();

    for (const file of e2eTypeScriptFiles()) {
      const count = [
        ...fs
          .readFileSync(file, "utf8")
          .matchAll(/\.post\(\s*["']\/api\/bookings["']/g),
      ].length;
      if (count > 0) actual.set(repoRelative(file), count);
    }

    expect(actual).toEqual(expected);
    for (const file of expected.keys()) {
      expect(source(file)).toMatch(/headers:\s*\w+\.headers/);
    }
  });

  it("does not restore a blanket booking-create header on member contexts", () => {
    const memberJourney = source("e2e/member-policy-exception-requests.spec.ts");
    expect(memberJourney).not.toMatch(
      /newContext\(\{[\s\S]{0,200}extraHTTPHeaders:[\s\S]{0,100}x-forwarded-for/,
    );
  });
});
