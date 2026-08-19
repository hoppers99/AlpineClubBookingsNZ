// #2919 review — EVERY surface that puts a booking-message body on a screen
// must render it through the booking-message renderer, never by hand.
//
// WHY THIS FILE EXISTS. All 12 message definitions declare every token as
// insertable (`tokens: ALL_TOKENS`), so an operator may put
// `{{CLUB_LODGE_NAME}}` — or `{{SUPPORT_EMAIL}}`, or `{{amountDue}}` — into any
// of them. The admin preview renders all of them. Four live client surfaces used
// to substitute at most `{{paymentReference}}` with `.replaceAll(...)` and print
// the rest as literal braces to the member: worse than the blank #2919 set out
// to fix. Nothing failed, because a template is just a string and a missing
// substitution is legal to the compiler.
//
// The census (a registry that must equal what the tree actually contains) is the
// part that survives: a NEW surface that fetches message bodies fails here until
// it is registered, and it cannot be registered without routing through the
// renderer. Note this file reads the tree from disk, so it has no import edge to
// the files it scans and `vitest related` cannot select it — that is the known
// blind spot of source-scanning contracts here, and CI is what runs it.
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  BOOKING_MESSAGE_DEFINITIONS,
  renderClientBookingMessage,
} from "@/lib/booking-message-definitions";

/**
 * Files that read booking-message bodies and put them on a screen, with the
 * lodge each one names for `{{CLUB_LODGE_NAME}}`.
 *
 * `lodgePass` is the text every `renderClientBookingMessage` call in that file
 * must carry — the expression that hands the renderer this stay's own lodge.
 * Every client surface has one, because every one of them knows which stay it is
 * talking about. If a future surface genuinely cannot know, it still renders
 * through the renderer: the club default then stands in and an unsupplied token
 * blanks, which is the contract. What it may never do is print the braces.
 */
const RENDER_SURFACES: Array<{
  file: string;
  what: string;
  lodgePass: string | null;
}> = [
  {
    file: "src/app/(authenticated)/bookings/[id]/page.tsx",
    what: "the member booking detail page",
    // A server component: it builds the merge data itself rather than taking
    // club tokens off the wire, and its own contract test
    // (booking-message-merge-data-contract.test.ts) pins the lodge it uses.
    lodgePass: null,
  },
  {
    file: "src/app/(public)/pay/[token]/page.tsx",
    what: "the public payment-link page",
    lodgePass: "lodgeName: context.lodgeName ?? null",
  },
  {
    file: "src/app/(authenticated)/book/_hooks/use-booking-wizard.ts",
    what: "the booking wizard's payment-method copy",
    lodgePass: "lodgeName: selectedLodge?.name ?? null",
  },
  {
    file: "src/app/(website-dynamic)/join/[code]/member-group-join-panel.tsx",
    what: "the member group-join panel",
    lodgePass: "lodgeName: summary.lodgeName",
  },
  {
    file: "src/components/group-booking/organiser-group-booking-card.tsx",
    what: "the organiser group-booking card",
    // Shorthand: the server page passes the booking's lodge in as this prop.
    lodgePass: "lodgeName,",
  },
  {
    file: "src/app/api/admin/booking-messages/preview/route.ts",
    what: "the admin preview",
    // Sample data by design: there is no booking to read a lodge from.
    lodgePass: null,
  },
];

/** Every `renderClientBookingMessage(...)` call's source text, parens balanced. */
function clientRenderCalls(code: string): string[] {
  const calls: string[] = [];
  const needle = "renderClientBookingMessage(";
  let from = 0;
  for (;;) {
    const start = code.indexOf(needle, from);
    if (start === -1) return calls;
    const open = start + needle.length - 1;
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") {
        depth--;
        if (depth === 0) {
          calls.push(code.slice(open, i + 1));
          from = i + 1;
          break;
        }
      }
      if (i === code.length - 1) {
        throw new Error("Unbalanced renderClientBookingMessage call");
      }
    }
  }
}

/**
 * Files that legitimately carry message bodies WITHOUT rendering them: the
 * settings loaders, the endpoint that serves the raw templates to the client
 * surfaces above, and the admin editor (which edits the template itself, braces
 * and all).
 */
const NON_RENDERING_CARRIERS = [
  "src/lib/booking-message-settings.ts",
  "src/app/api/booking-messages/route.ts",
  "src/app/api/admin/booking-messages/route.ts",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  // Test helper: walks the repository's own src/ tree, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  for (const entry of readdirSync(path.resolve(process.cwd(), dir))) {
    const relative = `${dir}/${entry}`;
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const absolute = path.resolve(process.cwd(), relative);
    if (statSync(absolute).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      out.push(...listSourceFiles(relative));
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry))) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
    out.push(relative);
  }
  return out;
}

function read(file: string): string {
  // Test helper: a fixed repository path under process.cwd().
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), file), "utf8");
}

/** Strip `//` and block comments so only EXECUTABLE text is matched. */
function stripComments(source: string): string {
  let out = "";
  let state: "code" | "line" | "block" = "code";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        i++;
      } else if (c === "/" && next === "*") {
        state = "block";
        i++;
      } else {
        out += c;
      }
    } else if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
    } else if (c === "*" && next === "/") {
      state = "code";
      i++;
    }
  }
  return out;
}

const ALL_SOURCE_FILES = listSourceFiles("src");

/** Files that touch the booking-message bodies at all. */
const CARRIERS = ALL_SOURCE_FILES.filter((file) => {
  const code = stripComments(read(file));
  return (
    code.includes('"/api/booking-messages"') ||
    code.includes("loadPublicBookingMessages") ||
    code.includes("loadEffectiveBookingMessageMap") ||
    code.includes("buildSampleBookingMessageData") ||
    code.includes("loadBookingMessagesForAdmin") ||
    code.includes("renderBookingMessageTemplate") ||
    code.includes("renderClientBookingMessage")
  );
});

describe("every surface that renders a booking-message body (#2919)", () => {
  it("is registered here — a new one has to declare how it renders", () => {
    const registered = new Set([
      ...RENDER_SURFACES.map((surface) => surface.file),
      ...NON_RENDERING_CARRIERS,
      // The renderer's own home, and the helper it exports.
      "src/lib/booking-message-definitions.ts",
    ]);
    const unregistered = CARRIERS.filter((file) => !registered.has(file));

    // An unregistered file reads message bodies and nothing has checked whether
    // it substitutes their tokens. Register it above (and route it through the
    // renderer) rather than deleting this assertion.
    expect(unregistered).toEqual([]);
  });

  it("names files that really exist, so the registry cannot rot silently", () => {
    for (const surface of [
      ...RENDER_SURFACES.map((s) => s.file),
      ...NON_RENDERING_CARRIERS,
    ]) {
      expect(ALL_SOURCE_FILES, `${surface} is registered but not in src/`).toContain(
        surface
      );
    }
  });

  it.each(RENDER_SURFACES)(
    "renders through the booking-message renderer: $what",
    ({ file }) => {
      const code = stripComments(read(file));

      expect(
        /render(Client)?BookingMessage(Template)?\(/.test(code),
        `${file} puts a message body on screen without rendering its tokens`
      ).toBe(true);
    }
  );

  it.each(RENDER_SURFACES.filter((surface) => surface.lodgePass))(
    "names the stay's own lodge rather than the club default: $what",
    ({ file, lodgePass }) => {
      const calls = clientRenderCalls(stripComments(read(file)));

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // The whole point of #2919 on this surface: {{CLUB_LODGE_NAME}} resolves
        // from the lodge this booking or group is at. EVERY call, not just the
        // first — the organiser card renders two message bodies.
        expect(call, `${file}: a render call with no lodge of its own`).toContain(
          lodgePass!
        );
      }
    }
  );

  it("substitutes no booking-message token by hand, anywhere under src/", () => {
    // `.replaceAll("{{paymentReference}}", ref)` is how all four client surfaces
    // used to do it: one token substituted, every other one printed as braces.
    const handSubstitution = ALL_SOURCE_FILES.filter((file) =>
      /\.(replaceAll|replace|split)\(\s*["'`]\{\{/.test(stripComments(read(file)))
    );

    expect(handSubstitution).toEqual([]);
  });
});

describe("the client renderer's contract (#2919)", () => {
  const clubTokens = {
    CLUB_NAME: "Alpine Club",
    CLUB_LODGE_NAME: "Default Lodge",
    BASE_URL: "https://example.test",
    SUPPORT_EMAIL: "support@example.test",
  };

  it("substitutes every club-level token, not only the payment reference", () => {
    expect(
      renderClientBookingMessage({
        template:
          "Transfer to {{CLUB_LODGE_NAME}} ({{CLUB_NAME}}) using {{paymentReference}}. Help: {{SUPPORT_EMAIL}} {{BASE_URL}}",
        fallback: "unused",
        clubTokens,
        data: { paymentReference: "BOOK-ABC123" },
      })
    ).toBe(
      "Transfer to Default Lodge (Alpine Club) using BOOK-ABC123. Help: support@example.test https://example.test"
    );
  });

  it("prefers the stay's own lodge over the club default", () => {
    expect(
      renderClientBookingMessage({
        template: "Your stay at {{CLUB_LODGE_NAME}}.",
        fallback: "unused",
        clubTokens,
        lodgeName: "Second Lodge",
      })
    ).toBe("Your stay at Second Lodge.");
  });

  it("blanks a token it has no value for rather than showing braces", () => {
    expect(
      renderClientBookingMessage({
        template: "Reference {{paymentReference}} at {{CLUB_LODGE_NAME}}.",
        fallback: "unused",
        clubTokens: null,
      })
    ).toBe("Reference  at .");
  });

  it("uses the shipped default body until the fetch answers", () => {
    expect(
      renderClientBookingMessage({
        template: undefined,
        fallback: "Pay at {{CLUB_LODGE_NAME}}.",
        clubTokens,
        lodgeName: "Second Lodge",
      })
    ).toBe("Pay at Second Lodge.");
  });

  it("covers a token set every message really declares", () => {
    // Not a formality: this is why one surface cannot get away with substituting
    // only the tokens its own default body happens to use.
    for (const definition of BOOKING_MESSAGE_DEFINITIONS) {
      expect(definition.tokens).toContain("CLUB_LODGE_NAME");
    }
  });
});
