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
import {
  checkRateLimitInMemory,
  getClientIp,
  rateLimiters,
} from "../rate-limit";

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

function parseSourceText(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
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
  if (ts.isTemplateExpression(resolved)) {
    let value = resolved.head.text;
    for (const span of resolved.templateSpans) {
      const interpolation = resolveStaticString(span.expression, bindings);
      if (interpolation === null) return null;
      value += interpolation + span.literal.text;
    }
    return value;
  }
  if (
    ts.isBinaryExpression(resolved) &&
    resolved.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = resolveStaticString(resolved.left, bindings);
    const right = resolveStaticString(resolved.right, bindings);
    return left === null || right === null ? null : left + right;
  }
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

function isDestructuredRequestAlias(
  identifier: ts.Identifier,
  method: "fetch" | "post",
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        if (
          ts.isIdentifier(element.name) &&
          element.name.text === identifier.text &&
          (element.propertyName
            ? propertyName(element.propertyName) === method
            : element.name.text === method)
        ) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(identifier.getSourceFile());
  return found;
}

function isRequestCallable(
  expression: ts.Expression,
  method: "fetch" | "post",
  bindings: ConstBindings,
  seen = new Set<ts.Node>(),
): boolean {
  const resolved = resolveConstExpression(expression, bindings);
  if (seen.has(resolved)) return false;
  seen.add(resolved);

  if (ts.isPropertyAccessExpression(resolved)) {
    return resolved.name.text === method;
  }
  if (ts.isElementAccessExpression(resolved)) {
    return resolveStaticString(resolved.argumentExpression, bindings) === method;
  }
  if (ts.isIdentifier(resolved)) {
    return isDestructuredRequestAlias(resolved, method);
  }
  if (ts.isCallExpression(resolved)) {
    const callee = unwrapExpression(resolved.expression);
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "bind" &&
      isRequestCallable(callee.expression, method, bindings, seen)
    );
  }
  return false;
}

function classifyBookingCreateRoute(
  expression: ts.Expression | undefined,
  bindings: ConstBindings,
): "exact" | "other" | "unresolved" {
  const route = resolveStaticString(expression, bindings);
  if (route === null) {
    if (!expression) return "unresolved";
    const resolved = resolveConstExpression(expression, bindings);
    if (ts.isTemplateExpression(resolved)) {
      const head = resolved.head.text;
      const tail = resolved.templateSpans.map((span) => span.literal.text).join("");
      if (
        head.startsWith("/api/admin/") ||
        head.startsWith("/api/booking-requests/") ||
        (head.startsWith("/api/bookings/") && /[a-z]/i.test(tail))
      ) {
        return "other";
      }
    }
    return "unresolved";
  }
  try {
    const pathname = new URL(route, "https://e2e-contract.invalid").pathname;
    const normalized = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
    return normalized === "/api/bookings" ? "exact" : "other";
  } catch {
    return "unresolved";
  }
}

function propertyName(
  node: ts.PropertyName,
  bindings?: ConstBindings,
): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (bindings && ts.isComputedPropertyName(node)) {
    return resolveStaticString(node.expression, bindings);
  }
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

type FunctionProducer =
  | ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.FunctionExpression;

function functionReturns(producer: FunctionProducer): ts.Expression[] | null {
  if (!producer.body) return null;
  if (!ts.isBlock(producer.body)) return [producer.body];

  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== producer.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(producer.body);
  return returns.length > 0 ? returns : null;
}

function producedExpressions(
  expression: ts.Expression,
  bindings: ConstBindings,
  seen = new Set<ts.Node>(),
): ts.Expression[] | null {
  const resolved = resolveConstExpression(expression, bindings);
  if (seen.has(resolved)) return null;
  seen.add(resolved);

  if (!ts.isCallExpression(resolved) || resolved.arguments.length > 0) {
    return [resolved];
  }

  const callee = resolveConstExpression(resolved.expression, bindings);
  if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
    return functionReturns(callee);
  }
  if (!ts.isIdentifier(callee)) return null;

  const declarations: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === callee.text
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(callee.getSourceFile());
  return declarations.length === 1 ? functionReturns(declarations[0]) : null;
}

function containsForwardedFor(
  expression: ts.Expression,
  bindings: ConstBindings,
  seen = new Set<ts.Node>(),
): boolean | null {
  const produced = producedExpressions(expression, bindings, seen);
  if (!produced) return null;

  let unresolved = false;
  for (const resolved of produced) {
    if (ts.isObjectLiteralExpression(resolved)) {
      for (const property of resolved.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = containsForwardedFor(property.expression, bindings, seen);
          if (spread === true) return true;
          if (spread === null) unresolved = true;
          continue;
        }
        if (
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)
        ) {
          const name = propertyName(property.name, bindings);
          if (name?.toLowerCase() === "x-forwarded-for") return true;
          if (name === null) unresolved = true;
        }
      }
      continue;
    }

    if (ts.isPropertyAccessExpression(resolved) && resolved.name.text === "headers") {
      const owner = resolveConstExpression(resolved.expression, bindings);
      if (ts.isCallExpression(owner) && calledName(owner) === "bookingCreateIsolation") {
        return true;
      }
    }
    unresolved = true;
  }
  return unresolved ? null : false;
}

function objectPropertyExpressions(
  expression: ts.Expression | undefined,
  name: string,
  bindings: ConstBindings,
  seen = new Set<ts.Node>(),
): ts.Expression[] | null {
  if (!expression) return [];
  const produced = producedExpressions(expression, bindings, seen);
  if (!produced) return null;

  const values: ts.Expression[] = [];
  for (const resolved of produced) {
    if (!ts.isObjectLiteralExpression(resolved)) return null;
    for (const property of resolved.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadValues = objectPropertyExpressions(
          property.expression,
          name,
          bindings,
          seen,
        );
        if (spreadValues === null) return null;
        values.push(...spreadValues);
        continue;
      }
      const resolvedName = propertyName(property.name, bindings);
      if (resolvedName === null) return null;
      if (resolvedName !== name) continue;
      if (ts.isPropertyAssignment(property)) values.push(property.initializer);
      if (ts.isShorthandPropertyAssignment(property)) values.push(property.name);
    }
  }
  return values;
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

const BOOKING_CREATE_BUTTON_NAMES = [
  "Confirm Booking",
  "Create without emailing",
  "Create and email them",
  "Continue to Payment",
  "Save as Draft",
] as const;

type BrowserTrigger =
  | Readonly<{ kind: "create"; label: string }>
  | Readonly<{ kind: "other" }>
  | Readonly<{ kind: "unresolved" }>;

function regexFromLiteral(expression: ts.Expression): RegExp | null {
  if (expression.kind !== ts.SyntaxKind.RegularExpressionLiteral) return null;
  const literal = expression.getText();
  const lastSlash = literal.lastIndexOf("/");
  if (!literal.startsWith("/") || lastSlash === 0) return null;
  try {
    return new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1));
  } catch {
    return null;
  }
}

function bookingCreateMatcher(
  expression: ts.Expression | undefined,
  bindings: ConstBindings,
  selector: boolean,
): BrowserTrigger {
  if (!expression) return { kind: "unresolved" };
  const resolved = resolveConstExpression(expression, bindings);
  const text = resolveStaticString(resolved, bindings);
  if (text !== null) {
    const normalized = text.toLowerCase().replace(/[^a-z]+/g, " ");
    const label = BOOKING_CREATE_BUTTON_NAMES.find((candidate) => {
      if (!selector) return text === candidate;
      const candidateWords = candidate.toLowerCase().replace(/[^a-z]+/g, " ");
      return normalized.includes(candidateWords);
    });
    return label ? { kind: "create", label } : { kind: "other" };
  }

  let regex = regexFromLiteral(resolved);
  if (
    !regex &&
    (ts.isCallExpression(resolved) || ts.isNewExpression(resolved)) &&
    calledName(resolved as ts.CallExpression) === "RegExp"
  ) {
    const pattern = resolveStaticString(resolved.arguments?.[0], bindings);
    const flags = resolveStaticString(resolved.arguments?.[1], bindings) ?? "";
    if (pattern !== null) {
      try {
        regex = new RegExp(pattern, flags);
      } catch {
        return { kind: "unresolved" };
      }
    }
  }
  if (regex) {
    const label = BOOKING_CREATE_BUTTON_NAMES.find((candidate) => {
      regex!.lastIndex = 0;
      return regex!.test(candidate);
    });
    return label ? { kind: "create", label } : { kind: "other" };
  }
  return /confirm.*book|create|submit.*book|request.*book/i.test(resolved.getText())
    ? { kind: "unresolved" }
    : { kind: "other" };
}

function classifyBookingCreateLocator(
  locatorExpression: ts.Expression,
  bindings: ConstBindings,
): BrowserTrigger | null {
  const locator = resolveConstExpression(locatorExpression, bindings);
  const getByRole = childCallNamed(locator, "getByRole");
  const getByText = childCallNamed(locator, "getByText");
  const locatorCall = childCallNamed(locator, "locator");
  if (!getByRole && !getByText && !locatorCall) {
    return /confirm.*book|create|submit.*book|request.*book/i.test(
      locatorExpression.getText(),
    )
      ? { kind: "unresolved" }
      : null;
  }

  if (getByRole) {
    const role = resolveStaticString(getByRole.arguments[0], bindings);
    if (role !== "button") {
      return role === null ? { kind: "unresolved" } : { kind: "other" };
    }
    const names = objectPropertyExpressions(
      getByRole.arguments[1],
      "name",
      bindings,
    );
    if (names === null || names.length > 1) return { kind: "unresolved" };
    if (names.length === 0) {
      return /confirm.*book|create|submit.*book|request.*book/i.test(
        locator.getText(),
      )
        ? { kind: "unresolved" }
        : { kind: "other" };
    }
    return bookingCreateMatcher(names[0], bindings, false);
  }

  if (getByText) {
    return bookingCreateMatcher(getByText.arguments[0], bindings, true);
  }

  return locatorCall
    ? bookingCreateMatcher(locatorCall.arguments[0], bindings, true)
    : null;
}

function immediatelyFocusedBookingTarget(
  action: ts.CallExpression,
  bindings: ConstBindings,
): BrowserTrigger | null {
  let statement: ts.Node = action;
  while (statement.parent && !ts.isStatement(statement)) {
    statement = statement.parent;
  }
  if (
    !ts.isStatement(statement) ||
    (!ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent))
  ) {
    return null;
  }
  const statements = statement.parent.statements;
  const index = statements.indexOf(statement);
  if (index < 1) return null;
  const focus = childCallNamed(statements[index - 1], "focus");
  if (!focus) return null;
  const callee = unwrapExpression(focus.expression);
  return ts.isPropertyAccessExpression(callee)
    ? classifyBookingCreateLocator(callee.expression, bindings)
    : null;
}

function bookingCreateTrigger(
  action: ts.CallExpression,
  bindings: ConstBindings,
  failClosedBookingSpec: boolean,
): BrowserTrigger | null {
  const callee = unwrapExpression(action.expression);
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!new Set(["click", "press", "dispatchEvent"]).has(callee.name.text)) {
    return null;
  }

  if (
    callee.name.text === "press" &&
    ts.isPropertyAccessExpression(unwrapExpression(callee.expression)) &&
    (unwrapExpression(callee.expression) as ts.PropertyAccessExpression).name
      .text === "keyboard"
  ) {
    const key = resolveStaticString(action.arguments[0], bindings);
    if (key === "Enter" && failClosedBookingSpec) {
      return { kind: "unresolved" };
    }
    const focusedTarget = immediatelyFocusedBookingTarget(action, bindings);
    if (key === "Enter") return focusedTarget;
    if (key === null && focusedTarget && focusedTarget.kind !== "other") {
      return { kind: "unresolved" };
    }
    return null;
  }

  const target = classifyBookingCreateLocator(callee.expression, bindings);
  if (!target) return null;

  if (callee.name.text === "press") {
    const key = resolveStaticString(action.arguments[0], bindings);
    if (key !== "Enter") return key === null ? { kind: "unresolved" } : null;
  } else if (callee.name.text === "dispatchEvent") {
    const event = resolveStaticString(action.arguments[0], bindings);
    if (event === "submit" && target.kind === "other" && failClosedBookingSpec) {
      return { kind: "unresolved" };
    }
    if (event !== "click" && event !== "submit") {
      if (event !== "keydown" && event !== "keypress") {
        return event === null ? { kind: "unresolved" } : null;
      }
      const keys = objectPropertyExpressions(action.arguments[1], "key", bindings);
      if (keys === null) return { kind: "unresolved" };
      const resolvedKeys = keys.map((key) => resolveStaticString(key, bindings));
      if (!resolvedKeys.includes("Enter")) {
        return resolvedKeys.includes(null) ? { kind: "unresolved" } : null;
      }
    }
  }
  return target;
}

function analyzeDirectPosts(sourceFile: ts.SourceFile, file: string) {
  const bindings = collectConstBindings(sourceFile);
  const exact: string[] = [];
  const unresolved: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isPost = isRequestCallable(node.expression, "post", bindings);
      const isFetch = isRequestCallable(node.expression, "fetch", bindings);
      if (!isPost && !isFetch) {
        ts.forEachChild(node, visit);
        return;
      }
      const route = classifyBookingCreateRoute(node.arguments[0], bindings);
      if (isFetch) {
        const options = node.arguments[1];
        const methods = options
          ? objectPropertyExpressions(options, "method", bindings)
          : [];
        const method =
          methods === null || methods.length > 1
            ? null
            : methods.length === 0
              ? "GET"
              : (resolveStaticString(methods[0], bindings)?.toUpperCase() ?? null);
        if (method !== "POST") {
          if (method === null && route === "exact") {
            unresolved.push(
              `${file}:${node.arguments[1]?.getText(sourceFile) ?? "<missing-options>"}`,
            );
          }
          ts.forEachChild(node, visit);
          return;
        }
      }
      if (route === "exact") {
        exact.push(`${file}:${enclosingFunctionName(node) ?? "<top-level>"}`);
      } else if (route === "unresolved") {
        unresolved.push(
          `${file}:${node.arguments[0]?.getText(sourceFile) ?? "<missing-route>"}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { exact, unresolved };
}

function analyzeBrowserTriggers(sourceFile: ts.SourceFile, file: string) {
  const bindings = collectConstBindings(sourceFile);
  const failClosedBookingSpec = E2E_BOOKING_CREATE_CENSUS.some(
    (entry) => entry.transport === "browser" && entry.file === file,
  );
  const create: string[] = [];
  const unresolved: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const trigger = bookingCreateTrigger(node, bindings, failClosedBookingSpec);
      if (
        trigger &&
        trigger.kind !== "other" &&
        enclosingActionConsumer(node) !== "withBookingCreateClientIp"
      ) {
        const label = trigger.kind === "create" ? trigger.label : node.getText(sourceFile);
        (trigger.kind === "create" ? create : unresolved).push(`${file}:${label}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { create, unresolved };
}

function analyzeBlanketContexts(sourceFile: ts.SourceFile, file: string) {
  const bindings = collectConstBindings(sourceFile);
  const present: string[] = [];
  const unresolved: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const surface = calledName(node);
      const location = `${file}:${enclosingFunctionName(node) ?? "<top-level>"}:${surface}`;
      const headers =
        surface === "newContext" || surface === "newPage"
          ? objectPropertyExpressions(
              node.arguments[0],
              "extraHTTPHeaders",
              bindings,
            )
          : surface === "setExtraHTTPHeaders"
            ? node.arguments[0]
              ? [node.arguments[0]]
              : null
            : undefined;
      if (headers === undefined) {
        ts.forEachChild(node, visit);
        return;
      }
      if (headers === null) {
        unresolved.push(`${location}:${node.getText(sourceFile)}`);
      } else {
        for (const header of headers) {
          const status = containsForwardedFor(header, bindings);
          if (status === true) present.push(location);
          if (status === null) {
            unresolved.push(`${location}:${header.getText(sourceFile)}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { present, unresolved };
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
  it("keeps ordered same-stack runtime evidence reproducible without resetting auth", () => {
    const stackScript = source("scripts/e2e-stack.sh");
    const guide = source("docs/E2E_PLAYWRIGHT.md");

    expect(stackScript).toContain(
      'if [[ "${E2E_PRESERVE_AUTH_STATE:-0}" != "1" ]]; then',
    );
    expect(stackScript).toMatch(
      /if \[\[ "\$\{E2E_PRESERVE_AUTH_STATE:-0\}" != "1" \]\]; then\s+rm -rf e2e\/\.auth\s+fi/,
    );
    expect(guide).toContain(
      "E2E_PRESERVE_AUTH_STATE=1 scripts/e2e-stack.sh run " +
        "e2e/waitlist.spec.ts e2e/whole-lodge-request.spec.ts",
    );
  });

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

  it("normalizes static booking routes and common direct POST aliases", () => {
    const sourceFile = parseSourceText(
      "direct-positive-negative.ts",
      [
        'const resource = "bookings";',
        "request.post(`/api/${resource}`, { data: {} });",
        "const boundCreate = request.post.bind(request);",
        'boundCreate("https://club.invalid/api/" + resource + "?retry=1", {});',
        "const { post: aliasedPost } = request;",
        "aliasedPost(`/api/${resource}/`, {});",
        "const boundFetch = request.fetch.bind(request);",
        'boundFetch("/api/" + resource + "?source=fetch", { method: "PO" + "ST" });',
        "const { fetch: aliasedFetch } = request;",
        'aliasedFetch("https://club.invalid/api/bookings", { method: `POST` });',
        'request.fetch("/api/bookings", { method: runtimeMethod });',
        'request.fetch("/api/bookings");',
        'request.fetch("/api/bookings", { headers: { accept: "application/json" } });',
        'request.fetch("/api/bookings", { method: "GET" });',
        "request.post(`/api/bookings/${bookingId}/cancel`, {});",
        'request.post("/api/admin/bookings", {});',
      ].join("\n"),
    );

    expect(analyzeDirectPosts(sourceFile, "fixture")).toEqual({
      exact: [
        "fixture:<top-level>",
        "fixture:<top-level>",
        "fixture:<top-level>",
        "fixture:<top-level>",
        "fixture:<top-level>",
      ],
      unresolved: ["fixture:{ method: runtimeMethod }"],
    });
  });

  it("recognizes equivalent browser create triggers and rejects unknown ones", () => {
    const sourceFile = parseSourceText(
      "browser-positive-negative.ts",
      [
        'const roleName = "button";',
        'const optionName = "name";',
        "page.getByRole(`${roleName}`, { [`${optionName}`]: /Continue to Payment|Confirm Booking/ }).click();",
        'const createText = "Create without emailing";',
        "page.getByText(`${createText}`).press(`Enter`);",
        "page.locator(`button:has-text('Create and email them')`).dispatchEvent(`click`);",
        'page.getByText("Continue to Payment").dispatchEvent("submit");',
        'page.getByRole("button", { name: "Save as Draft" }).click();',
        'const keyboardSubmit = page.getByRole("button", { name: "Confirm Booking" });',
        "keyboardSubmit.focus();",
        'page.keyboard.press("Enter");',
        "page.getByRole(`button`, { name: confirmBookingLabel }).click();",
        'page.getByRole("button", { name: "Cancel" }).click();',
        'page.getByText("Confirm Booking").press("Escape");',
        'page.locator("#confirm-booking").dispatchEvent("input");',
        "withBookingCreateClientIp(page, isolation, () => page.getByText(`Confirm Booking`).click());",
      ].join("\n"),
    );

    expect(analyzeBrowserTriggers(sourceFile, "fixture")).toEqual({
      create: [
        "fixture:Confirm Booking",
        "fixture:Create without emailing",
        "fixture:Create and email them",
        "fixture:Continue to Payment",
        "fixture:Save as Draft",
        "fixture:Confirm Booking",
      ],
      unresolved: [
        'fixture:page.getByRole(`button`, { name: confirmBookingLabel }).click()',
      ],
    });
  });

  it("detects the dual-hat draft action when its exact wrapper is mutated away", () => {
    const actual = source("e2e/dual-hat-booking.spec.ts");
    const mutated = actual.replace(
      "await withBookingCreateClientIp(",
      "await withoutBookingCreateClientIp(",
    );
    expect(mutated).not.toBe(actual);

    const result = analyzeBrowserTriggers(
      parseSourceText("dual-hat-wrapper-mutation.ts", mutated),
      "e2e/dual-hat-booking.spec.ts",
    );
    expect(result.create).toContain(
      "e2e/dual-hat-booking.spec.ts:Save as Draft",
    );
    expect(result.unresolved).toEqual([]);
  });

  it("fails closed for form submit and raw Enter in registered browser-create specs", () => {
    const bookingSource = parseSourceText(
      "registered-booking-submit.ts",
      [
        'const submitButton = page.getByRole("button", { name: "Confirm Booking" });',
        "submitButton.focus();",
        "await expect(submitButton).toBeFocused();",
        'page.keyboard.press("Enter");',
        'page.locator("form").dispatchEvent("submit");',
        'page.keyboard.press("Escape");',
        'withBookingCreateClientIp(page, isolation, () => page.keyboard.press("Enter"));',
      ].join("\n"),
    );

    expect(analyzeBrowserTriggers(bookingSource, "e2e/booking.spec.ts")).toEqual({
      create: [],
      unresolved: [
        'e2e/booking.spec.ts:page.keyboard.press("Enter")',
        'e2e/booking.spec.ts:page.locator("form").dispatchEvent("submit")',
      ],
    });

    const unrelatedSource = parseSourceText(
      "unrelated-enter.ts",
      'page.keyboard.press("Enter");',
    );
    expect(
      analyzeBrowserTriggers(unrelatedSource, "e2e/help-widget.spec.ts"),
    ).toEqual({ create: [], unresolved: [] });
  });

  it("detects computed and function-produced blanket headers fail closed", () => {
    const sourceFile = parseSourceText(
      "headers-positive-negative.ts",
      [
        'const headerSuffix = "for";',
        'const contextOption = "extraHTTPHeaders";',
        'const headers = { [`x-forwarded-${headerSuffix}`]: "10.240.250.1" };',
        "browser.newContext({ [`${contextOption}`]: headers });",
        'function makeHeaders() { return { "x-forwarded-for": "10.240.250.2" }; }',
        "function makeOptions() { return { extraHTTPHeaders: makeHeaders() }; }",
        "browser.newContext(makeOptions());",
        'browser.newPage({ extraHTTPHeaders: { "X-Forwarded-For": "10.240.250.3" } });',
        'page.setExtraHTTPHeaders({ ["X-" + "Forwarded-For"]: "10.240.250.4" });',
        "context.setExtraHTTPHeaders(makeHeaders());",
        "browser.newContext({ extraHTTPHeaders: buildAtRuntime(runtimeSeed) });",
        'browser.newContext({ extraHTTPHeaders: { authorization: "Bearer ***" } });',
        'page.setExtraHTTPHeaders({ authorization: "Bearer ***" });',
      ].join("\n"),
    );

    expect(analyzeBlanketContexts(sourceFile, "fixture")).toEqual({
      present: [
        "fixture:<top-level>:newContext",
        "fixture:<top-level>:newContext",
        "fixture:<top-level>:newPage",
        "fixture:<top-level>:setExtraHTTPHeaders",
        "fixture:<top-level>:setExtraHTTPHeaders",
      ],
      unresolved: [
        "fixture:<top-level>:newContext:buildAtRuntime(runtimeSeed)",
      ],
    });
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

  it("keeps waitlist and whole-lodge creates live after one and two Stripe retries", () => {
    // IP extraction and limiter namespacing happen before either production
    // store is selected. Drive the shipped in-process fallback directly here:
    // it uses the same `bookingCreate` id/key/budget as the shared Postgres
    // path, needs no storage mock or reset, and keeps this provider-free
    // reproduction deterministic. `rate-limit.test.ts` separately proves the
    // shared counter's atomic upsert and fallback boundary.
    const spendProductionBookingCreateBucket = (
      headers?: Readonly<Record<string, string>>,
    ) => {
      const request = new Request("https://club.example/api/bookings", {
        method: "POST",
        headers,
      });
      return checkRateLimitInMemory(
        rateLimiters.bookingCreate,
        getClientIp(request),
      );
    };

    // Reproduce the old serial-runner failure first. Twenty unlabelled creates
    // consume the shipped 20/hour `bookingCreate:unknown` bucket and the next
    // create is refused. This is the state a retry used to leave for a later
    // waitlist or whole-lodge setup call.
    expect(rateLimiters.bookingCreate).toMatchObject({
      id: "booking-create",
      limit: 20,
      windowSeconds: 60 * 60,
    });
    for (let requestNumber = 1; requestNumber <= 20; requestNumber += 1) {
      expect(
        spendProductionBookingCreateBucket(),
        `legacy shared request ${requestNumber} must consume the real bucket`,
      ).toMatchObject({ success: true, remaining: 20 - requestNumber });
    }
    expect(spendProductionBookingCreateBucket()).toMatchObject({
      success: false,
      remaining: 0,
    });

    const stripeAttempt = bookingCreateIsolation("stripe-success", 0);
    const stripeRetryOne = bookingCreateIsolation("stripe-success", 1);
    const stripeRetryTwo = bookingCreateIsolation("stripe-success", 2);
    const waitlistAttempt = bookingCreateIsolation("waitlist-placement", 0);
    const wholeLodgeAttempt = bookingCreateIsolation(
      "whole-lodge-held-anchor",
      0,
    );

    expect(
      new Set([
        stripeAttempt.clientIp,
        stripeRetryOne.clientIp,
        stripeRetryTwo.clientIp,
        waitlistAttempt.clientIp,
        wholeLodgeAttempt.clientIp,
      ]).size,
    ).toBe(5);

    // The original Stripe attempt and its first retry use separate production
    // keys. The two later waitlist creates share their own attempt bucket, and
    // the whole-lodge held-world create has another. All remain live even while
    // the old runner bucket above is already exhausted.
    expect(spendProductionBookingCreateBucket(stripeAttempt.headers)).toMatchObject({
      success: true,
      remaining: 19,
    });
    expect(
      spendProductionBookingCreateBucket(stripeRetryOne.headers),
    ).toMatchObject({ success: true, remaining: 19 });
    expect(
      spendProductionBookingCreateBucket(waitlistAttempt.headers),
    ).toMatchObject({ success: true, remaining: 19 });
    expect(
      spendProductionBookingCreateBucket(waitlistAttempt.headers),
    ).toMatchObject({ success: true, remaining: 18 });
    expect(
      spendProductionBookingCreateBucket(wholeLodgeAttempt.headers),
    ).toMatchObject({ success: true, remaining: 19 });

    // A second prior Stripe retry spends only retry 2's Stripe bucket. The
    // next waitlist and whole-lodge probes advance solely from their own prior
    // counts, proving the retry did not consume either downstream allowance.
    expect(
      spendProductionBookingCreateBucket(stripeRetryTwo.headers),
    ).toMatchObject({ success: true, remaining: 19 });
    expect(
      spendProductionBookingCreateBucket(waitlistAttempt.headers),
    ).toMatchObject({ success: true, remaining: 17 });
    expect(
      spendProductionBookingCreateBucket(wholeLodgeAttempt.headers),
    ).toMatchObject({ success: true, remaining: 18 });
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

  it("binds the complete 31-request census to explicit typed consumers", () => {
    expect(E2E_BOOKING_CREATE_CENSUS).toHaveLength(26);
    expect(
      E2E_BOOKING_CREATE_CENSUS.reduce(
        (total, entry) => total + ("requestsPerAttempt" in entry ? entry.requestsPerAttempt : 1),
        0,
      ),
    ).toBe(31);
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
      ["postBookingCreateSharedStoreProbe", "api"],
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

    for (const [file, functionName, requiredChild] of [
      [
        "e2e/helpers/booking.ts",
        "confirmBookingToPaymentStep",
        "withBookingCreateClientIp",
      ],
      [
        "e2e/member-policy-exception-requests.spec.ts",
        "bookThroughWizard",
        "withBookingCreateClientIp",
      ],
      [
        "e2e/booking-create-rate-isolation.spec.ts",
        "postBookingCreateSharedStoreProbe",
        "postBookingCreate",
      ],
    ] as const) {
      const sourceFile = parseSource(path.join(process.cwd(), file));
      const declaration = sourceFile.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === functionName,
      );
      expect(declaration, `${functionName} must remain a declared helper`).toBeDefined();
      expect(
        childCallNamed(declaration!, requiredChild),
        `${functionName} must keep its create action inside ${requiredChild}`,
      ).not.toBeNull();
    }
  });

  it("rejects every raw exact APIRequestContext booking-create POST", () => {
    const rawExactPosts: string[] = [];
    const unresolvedPostRoutes: string[] = [];
    for (const file of e2eTypeScriptFiles()) {
      const sourceFile = parseSource(file);
      const result = analyzeDirectPosts(sourceFile, repoRelative(file));
      rawExactPosts.push(...result.exact);
      unresolvedPostRoutes.push(...result.unresolved);
    }

    expect(rawExactPosts).toEqual([
      "e2e/helpers/booking-create-client-ip.ts:postBookingCreate",
    ]);
    expect(unresolvedPostRoutes).toEqual([]);
  });

  it("pins browser booking-create triggers inside the exact-action wrapper", () => {
    const unwrappedCandidates: string[] = [];
    const unresolvedCandidates: string[] = [];
    for (const file of e2eTypeScriptFiles()) {
      const sourceFile = parseSource(file);
      const result = analyzeBrowserTriggers(sourceFile, repoRelative(file));
      unwrappedCandidates.push(...result.create);
      unresolvedCandidates.push(...result.unresolved);
    }

    expect(unwrappedCandidates.sort()).toEqual(
      [
        "e2e/admin-retroactive-booking.spec.ts:Confirm Booking",
        "e2e/book-on-behalf-nonmember.spec.ts:Confirm Booking",
        "e2e/book-on-behalf-nonmember.spec.ts:Confirm Booking",
        "e2e/waitlist.spec.ts:Confirm Booking",
      ].sort(),
    );
    expect(unresolvedCandidates).toEqual([]);
  });

  it("rejects blanket context booking-create headers, including aliases", () => {
    const blanketContexts: string[] = [];
    const unresolvedContexts: string[] = [];
    for (const file of e2eTypeScriptFiles()) {
      const sourceFile = parseSource(file);
      const result = analyzeBlanketContexts(sourceFile, repoRelative(file));
      blanketContexts.push(...result.present);
      unresolvedContexts.push(...result.unresolved);
    }

    expect(blanketContexts).toEqual([
      "e2e/helpers/auth.ts:submitLoginForm:setExtraHTTPHeaders",
    ]);
    expect(unresolvedContexts).toEqual([]);
  });
});
