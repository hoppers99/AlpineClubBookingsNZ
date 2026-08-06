import fs from "node:fs";
import path from "node:path";
import type {
  APIRequestContext,
  Page,
  Request as PlaywrightRequest,
  Route,
} from "@playwright/test";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import {
  E2E_BOOKING_CREATE_CENSUS,
  bookingCreateIsolation,
  postBookingCreate,
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

type ConstBinding = Readonly<{
  declaration: ts.VariableDeclaration;
  initializer: ts.Expression;
  scope: ts.Node;
}>;

type ConstBindings = Map<string, ConstBinding[]>;

function parseSource(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function collectConstBindings(sourceFile: ts.SourceFile): ConstBindings {
  const bindings: ConstBindings = new Map();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const current = bindings.get(node.name.text) ?? [];
      let scope: ts.Node = node.parent;
      while (
        scope.parent &&
        !ts.isSourceFile(scope) &&
        !ts.isBlock(scope) &&
        !ts.isCaseBlock(scope) &&
        !ts.isFunctionLike(scope)
      ) {
        scope = scope.parent;
      }
      current.push({ declaration: node, initializer: node.initializer, scope });
      bindings.set(node.name.text, current);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function isAncestor(ancestor: ts.Node, node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function nodeDepth(node: ts.Node): number {
  let depth = 0;
  let current: ts.Node | undefined = node;
  while (current.parent) {
    depth += 1;
    current = current.parent;
  }
  return depth;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolveConstExpression(
  expression: ts.Expression,
  bindings: ConstBindings,
  seen = new Set<ts.Node>(),
): ts.Expression {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isIdentifier(unwrapped) || seen.has(unwrapped)) return unwrapped;
  const candidates = (bindings.get(unwrapped.text) ?? [])
    .filter(
      (binding) =>
        binding.declaration.getStart() < unwrapped.getStart() &&
        isAncestor(binding.scope, unwrapped),
    )
    .sort(
      (left, right) =>
        nodeDepth(right.scope) - nodeDepth(left.scope) ||
        right.declaration.getStart() - left.declaration.getStart(),
    );
  const binding = candidates[0];
  if (!binding) return unwrapped;
  seen.add(unwrapped);
  return resolveConstExpression(binding.initializer, bindings, seen);
}

function resolveStaticString(
  expression: ts.Expression | undefined,
  bindings: ConstBindings,
): string | null {
  if (!expression) return null;
  const resolved = resolveConstExpression(expression, bindings);
  if (ts.isStringLiteralLike(resolved)) return resolved.text;
  return null;
}

function calledName(call: ts.CallExpression): string | null {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (
    ts.isElementAccessExpression(callee) &&
    callee.argumentExpression &&
    ts.isStringLiteralLike(callee.argumentExpression)
  ) {
    return callee.argumentExpression.text;
  }
  return null;
}

function propertyName(node: ts.PropertyName): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return null;
}

function childCallNamed(node: ts.Node, name: string): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(candidate) && calledName(candidate) === name) {
      found = candidate;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function enclosingActionConsumer(node: ts.Node): string | null {
  let current: ts.Node | undefined = node;
  let nearest: string | null = null;
  while (current?.parent) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isCallExpression(current.parent) &&
      current.parent.arguments.includes(current)
    ) {
      const consumer = calledName(current.parent);
      nearest ??= consumer;
      if (consumer === "withBookingCreateClientIp") return consumer;
    }
    current = current.parent;
  }
  return nearest;
}

function enclosingFunctionName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      return current.name.text;
    }
    current = current.parent;
  }
  return null;
}

function containsForwardedFor(
  expression: ts.Expression,
  bindings: ConstBindings,
  seen = new Set<ts.Node>(),
): boolean {
  const resolved = resolveConstExpression(expression, bindings);
  if (seen.has(resolved)) return false;
  seen.add(resolved);

  if (ts.isObjectLiteralExpression(resolved)) {
    return resolved.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) {
        return containsForwardedFor(property.expression, bindings, seen);
      }
      if (
        (ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)) &&
        propertyName(property.name) === "x-forwarded-for"
      ) {
        return true;
      }
      return (
        ts.isPropertyAssignment(property) &&
        containsForwardedFor(property.initializer, bindings, seen)
      );
    });
  }

  if (!ts.isPropertyAccessExpression(resolved) || resolved.name.text !== "headers") {
    return false;
  }
  const owner = resolveConstExpression(resolved.expression, bindings);
  return ts.isCallExpression(owner) && calledName(owner) === "bookingCreateIsolation";
}

function objectPropertyExpressions(
  expression: ts.Expression | undefined,
  name: string,
  bindings: ConstBindings,
  seen = new Set<ts.Node>(),
): ts.Expression[] {
  if (!expression) return [];
  const resolved = resolveConstExpression(expression, bindings);
  if (seen.has(resolved) || !ts.isObjectLiteralExpression(resolved)) return [];
  seen.add(resolved);

  return resolved.properties.flatMap((property) => {
    if (ts.isSpreadAssignment(property)) {
      return objectPropertyExpressions(property.expression, name, bindings, seen);
    }
    if (propertyName(property.name) !== name) return [];
    if (ts.isPropertyAssignment(property)) return [property.initializer];
    if (ts.isShorthandPropertyAssignment(property)) return [property.name];
    return [];
  });
}

function directConsumerOf(expression: ts.Expression): string | null {
  let current: ts.Node = expression;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  return ts.isCallExpression(current.parent) &&
    current.parent.arguments.includes(current as ts.Expression)
    ? calledName(current.parent)
    : null;
}

const BOOKING_CREATE_BUTTON_NAMES = new Set([
  "Confirm Booking",
  "Create without emailing",
  "Create and email them",
  "/Continue to Payment|Confirm Booking/",
]);

function bookingCreateButtonName(
  click: ts.CallExpression,
  bindings: ConstBindings,
): string | null {
  const callee = unwrapExpression(click.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "click") {
    return null;
  }
  const locator = resolveConstExpression(callee.expression, bindings);
  const getByRole = childCallNamed(locator, "getByRole");
  if (!getByRole || resolveStaticString(getByRole.arguments[0], bindings) !== "button") {
    return null;
  }
  const optionsExpression = getByRole.arguments[1]
    ? resolveConstExpression(getByRole.arguments[1], bindings)
    : null;
  if (!optionsExpression || !ts.isObjectLiteralExpression(optionsExpression)) {
    return null;
  }
  const nameProperty = optionsExpression.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property.name) === "name",
  );
  if (!nameProperty) return null;
  const nameExpression = resolveConstExpression(nameProperty.initializer, bindings);
  const name = ts.isStringLiteralLike(nameExpression)
    ? nameExpression.text
    : nameExpression.kind === ts.SyntaxKind.RegularExpressionLiteral
      ? nameExpression.getText()
      : null;
  return name && BOOKING_CREATE_BUTTON_NAMES.has(name) ? name : null;
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

  it("merges direct-request headers through the one typed POST helper", async () => {
    const response = { ok: () => true };
    const request = {
      post: vi.fn(async () => response),
    } as unknown as APIRequestContext;
    const isolation = bookingCreateIsolation("waitlist-placement", 1);

    await expect(
      postBookingCreate(request, isolation, {
        headers: {
          authorization: "Bearer ***",
          "x-forwarded-for": "198.51.100.1",
        },
        data: { checkIn: "2026-08-01" },
      }),
    ).resolves.toBe(response);
    expect(request.post).toHaveBeenCalledWith("/api/bookings", {
      headers: {
        authorization: "Bearer ***",
        "x-forwarded-for": isolation.clientIp,
      },
      data: { checkIn: "2026-08-01" },
    });
  });

  it("adds the header only to the exact browser booking-create request", async () => {
    let handler: Parameters<Page["route"]>[1] | undefined;
    const bookingRequest = {
      method: () => "POST",
      url: () => "http://127.0.0.1:3000/api/bookings",
      headers: () => ({ cookie: "session=***" }),
    };
    const nonCreateRequest = {
      ...bookingRequest,
      method: () => "GET",
    };
    const page = {
      route: vi.fn(async (_pattern, registered) => {
        handler = registered;
      }),
      waitForRequest: vi.fn(
        async (predicate: (request: typeof bookingRequest) => boolean) => {
          expect(predicate(nonCreateRequest)).toBe(false);
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
          request: () => ({ ...nonCreateRequest }),
          continue: continueRequest,
        } as unknown as Route,
        {} as PlaywrightRequest,
      );
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
    expect(continueRequest).toHaveBeenNthCalledWith(1);
    expect(continueRequest).toHaveBeenNthCalledWith(2, {
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

  it("removes the exact browser route when the wrapped action rejects", async () => {
    let handler: Parameters<Page["route"]>[1] | undefined;
    const bookingRequest = {
      method: () => "POST",
      url: () => "http://127.0.0.1:3000/api/bookings",
      headers: () => ({}),
    };
    const page = {
      route: vi.fn(async (_pattern, registered) => {
        handler = registered;
      }),
      waitForRequest: vi.fn(async () => bookingRequest),
      unroute: vi.fn(async () => undefined),
    } as unknown as Page;

    await expect(
      withBookingCreateClientIp(
        page,
        bookingCreateIsolation("stripe-decline", 2),
        async () => {
          expect(handler).toBeTypeOf("function");
          throw new Error("action failed after route registration");
        },
      ),
    ).rejects.toThrow("action failed after route registration");
    expect(page.unroute).toHaveBeenCalledWith(
      "**/api/bookings",
      expect.any(Function),
    );
  });

  it("rejects two browser creates from one action and still removes the route", async () => {
    let handler: Parameters<Page["route"]>[1] | undefined;
    const bookingRequest = {
      method: () => "POST",
      url: () => "http://127.0.0.1:3000/api/bookings",
      headers: () => ({}),
    };
    const page = {
      route: vi.fn(async (_pattern, registered) => {
        handler = registered;
      }),
      waitForRequest: vi.fn(async () => bookingRequest),
      unroute: vi.fn(async () => undefined),
    } as unknown as Page;
    const continueRequest = vi.fn(async () => undefined);
    const route = {
      request: () => bookingRequest,
      continue: continueRequest,
    } as unknown as Route;

    await expect(
      withBookingCreateClientIp(
        page,
        bookingCreateIsolation("stripe-success", 2),
        async () => {
          expect(handler).toBeTypeOf("function");
          await handler!(route, {} as PlaywrightRequest);
          await handler!(route, {} as PlaywrightRequest);
        },
      ),
    ).rejects.toThrow(/issued 2 matching requests; expected exactly one/);
    expect(continueRequest).toHaveBeenCalledTimes(2);
    expect(page.unroute).toHaveBeenCalledWith(
      "**/api/bookings",
      expect.any(Function),
    );
  });

  it("binds the complete 27-request census to explicit typed consumers", () => {
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

    const consumerTransport = new Map<string, "api" | "browser">([
      ["postBookingCreate", "api"],
      ["withBookingCreateClientIp", "browser"],
      ["confirmBookingToPaymentStep", "browser"],
      ["bookThroughWizard", "browser"],
    ]);
    const uses: Array<{
      consumer: string | null;
      file: string;
      key: string | null;
      transport: "api" | "browser" | null;
    }> = [];

    for (const file of e2eTypeScriptFiles()) {
      if (file.endsWith("booking-create-client-ip.ts")) continue;
      const sourceFile = parseSource(file);
      const bindings = collectConstBindings(sourceFile);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          calledName(node) === "bookingCreateIsolation"
        ) {
          const consumer = directConsumerOf(node);
          uses.push({
            consumer,
            file: repoRelative(file),
            key: resolveStaticString(node.arguments[0], bindings),
            transport: consumer ? (consumerTransport.get(consumer) ?? null) : null,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    const usesByKey = Map.groupBy(uses, (use) => use.key);
    expect([...usesByKey.keys()].every((key) => key !== null)).toBe(true);
    expect(
      [...usesByKey.keys()].filter((key): key is string => key !== null).sort(),
    ).toEqual(E2E_BOOKING_CREATE_CENSUS.map((entry) => entry.key).sort());

    for (const entry of E2E_BOOKING_CREATE_CENSUS) {
      const keyUses = usesByKey.get(entry.key) ?? [];
      expect(keyUses, `${entry.key} must have its registered request count`).toHaveLength(
        "requestsPerAttempt" in entry ? entry.requestsPerAttempt : 1,
      );
      expect(
        keyUses.map(({ file, transport }) => ({ file, transport })),
        `${entry.key} must stay bound to its registered file and transport`,
      ).toEqual(
        Array.from({ length: keyUses.length }, () => ({
          file: entry.file,
          transport: entry.transport,
        })),
      );
    }

    for (const [file, functionName] of [
      ["e2e/helpers/booking.ts", "confirmBookingToPaymentStep"],
      ["e2e/member-policy-exception-requests.spec.ts", "bookThroughWizard"],
    ] as const) {
      const sourceFile = parseSource(path.join(process.cwd(), file));
      const declaration = sourceFile.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
      );
      expect(declaration, `${functionName} must remain a declared helper`).toBeDefined();
      expect(
        childCallNamed(declaration!, "withBookingCreateClientIp"),
        `${functionName} must keep its browser create action inside the route wrapper`,
      ).not.toBeNull();
    }
  });

  it("rejects every raw exact APIRequestContext booking-create POST", () => {
    const rawExactPosts: string[] = [];
    for (const file of e2eTypeScriptFiles()) {
      const sourceFile = parseSource(file);
      const bindings = collectConstBindings(sourceFile);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          calledName(node) === "post" &&
          resolveStaticString(node.arguments[0], bindings) === "/api/bookings"
        ) {
          rawExactPosts.push(
            `${repoRelative(file)}:${enclosingFunctionName(node) ?? "<top-level>"}`,
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(rawExactPosts).toEqual([
      "e2e/helpers/booking-create-client-ip.ts:postBookingCreate",
    ]);
  });

  it("pins browser booking-create triggers inside the exact-action wrapper", () => {
    const unwrappedCandidates: string[] = [];
    for (const file of e2eTypeScriptFiles()) {
      const sourceFile = parseSource(file);
      const bindings = collectConstBindings(sourceFile);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const buttonName = bookingCreateButtonName(node, bindings);
          if (
            buttonName &&
            enclosingActionConsumer(node) !== "withBookingCreateClientIp"
          ) {
            unwrappedCandidates.push(`${repoRelative(file)}:${buttonName}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(unwrappedCandidates.sort()).toEqual(
      [
        "e2e/admin-retroactive-booking.spec.ts:Confirm Booking",
        "e2e/book-on-behalf-nonmember.spec.ts:Confirm Booking",
        "e2e/book-on-behalf-nonmember.spec.ts:Confirm Booking",
        "e2e/waitlist.spec.ts:Confirm Booking",
      ].sort(),
    );
  });

  it("rejects blanket context booking-create headers, including aliases", () => {
    const blanketContexts: string[] = [];
    for (const file of e2eTypeScriptFiles()) {
      const sourceFile = parseSource(file);
      const bindings = collectConstBindings(sourceFile);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && calledName(node) === "newContext") {
          for (const headers of objectPropertyExpressions(
            node.arguments[0],
            "extraHTTPHeaders",
            bindings,
          )) {
            if (containsForwardedFor(headers, bindings)) {
              blanketContexts.push(repoRelative(file));
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(blanketContexts).toEqual([]);
  });
});
