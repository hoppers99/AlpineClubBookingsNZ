import { describe, expect, it } from "vitest";
import {
  formatRedactedJson,
  redactSensitiveJson,
  redactSensitiveQueryParams,
  redactSensitiveText,
} from "@/lib/redact-sensitive-json";

describe("redact-sensitive-json", () => {
  it("redacts sensitive header and token fields in nested payloads", () => {
    expect(
      redactSensitiveJson({
        response: {
          headers: {
            authorization: "Bearer live-token",
            "set-cookie": "session=abc123",
          },
        },
        request: {
          accessToken: "access-token",
          refresh_token: "refresh-token",
          password: "hunter2",
        },
      })
    ).toEqual({
      response: {
        headers: {
          authorization: "[REDACTED]",
          "set-cookie": "[REDACTED]",
        },
      },
      request: {
        accessToken: "[REDACTED]",
        refresh_token: "[REDACTED]",
        password: "[REDACTED]",
      },
    });
  });

  it("redacts JSON-shaped error text that includes an authorization header", () => {
    expect(
      redactSensitiveText(
        '400: {"response":{"statusCode":400,"request":{"headers":{"authorization":"Bearer live-token"}}}}'
      )
    ).toBe(
      '400: {"response":{"statusCode":400,"request":{"headers":{"authorization":"[REDACTED]"}}}}'
    );
  });

  it("redacts stripe token fields in structured payloads", () => {
    expect(
      redactSensitiveJson({
        payment: {
          stripeToken: "st_123",
          stripe_token: "st_456",
        },
      })
    ).toEqual({
      payment: {
        stripeToken: "[REDACTED]",
        stripe_token: "[REDACTED]",
      },
    });
  });

  it("preserves identifiers that merely contain a run of digits", () => {
    // cuids embed digit runs; e.g. "cmqdxeu50002101n22w2ivcas" contains
    // "50002101". These must not be treated as phone numbers, because they are
    // load-bearing in persisted payloads (e.g. a requeue's originalOperationId).
    expect(
      redactSensitiveJson({
        originalOperationId: "cmqdxeu50002101n22w2ivcas",
        bookingId: "cmp20vk3t00q12345678npunsc",
      })
    ).toEqual({
      originalOperationId: "cmqdxeu50002101n22w2ivcas",
      bookingId: "cmp20vk3t00q12345678npunsc",
    });
    expect(redactSensitiveText("cmqdxeu50002101n22w2ivcas")).toBe(
      "cmqdxeu50002101n22w2ivcas"
    );
  });

  it("still redacts standalone phone-like numbers on generic fields", () => {
    expect(redactSensitiveJson({ note: "call 021234567 today" })).toEqual({
      note: "[REDACTED]",
    });
    expect(redactSensitiveJson({ ref: "+64211234567" })).toEqual({
      ref: "[REDACTED]",
    });
  });

  it("redacts email and phone fields in structured payloads", () => {
    expect(
      redactSensitiveJson({
        email: "a@b.com",
        phone: "+64211234567",
      })
    ).toEqual({
      email: "[REDACTED]",
      phone: "[REDACTED]",
    });
  });

  it("redacts email values on generic fields", () => {
    expect(
      redactSensitiveJson({
        to: "a@b.com",
      })
    ).toEqual({
      to: "[REDACTED]",
    });
  });

  it("redacts Stripe payment method fields in structured payloads", () => {
    expect(
      redactSensitiveJson({
        payment_method: "pm_1ABC",
      })
    ).toEqual({
      payment_method: "[REDACTED]",
    });
  });

  it("redacts stripe token fields in JSON-shaped text", () => {
    expect(
      redactSensitiveText(
        '500: {"payment":{"stripeToken":"st_123","stripe_token":"st_456"}}'
      )
    ).toBe(
      '500: {"payment":{"stripeToken":"[REDACTED]","stripe_token":"[REDACTED]"}}'
    );
  });

  it("redacts newly sensitive keys in JSON-shaped text", () => {
    expect(
      redactSensitiveText(
        '500: {"email":"a@b.com","phone":"+64211234567","payment_method":"pm_1ABC","chargeId":"ch_1ABC"}'
      )
    ).toBe(
      '500: {"email":"[REDACTED]","phone":"[REDACTED]","payment_method":"[REDACTED]","chargeId":"[REDACTED]"}'
    );
  });

  it("formats redacted JSON for display", () => {
    expect(
      formatRedactedJson({
        headers: {
          authorization: "Bearer live-token",
        },
      })
    ).toContain('"authorization": "[REDACTED]"');
  });

  it("redacts token-bearing URL path segments", () => {
    expect(
      redactSensitiveText(
        "GET /membership-cancellation/abcDEF123_token-with-mixed 200 OK"
      )
    ).toBe("GET /membership-cancellation/[REDACTED] 200 OK");

    expect(
      redactSensitiveText(
        "https://example.test/membership-cancellation/x9_y7-zZ on visit"
      )
    ).toBe("https://example.test/membership-cancellation/[REDACTED] on visit");

    // Subsequent path segments stay intact.
    expect(
      redactSensitiveText(
        "/membership-cancellation/aA1_-/extra/path?keep=true"
      )
    ).toBe("/membership-cancellation/[REDACTED]/extra/path?keep=true");

    expect(
      redactSensitiveText(
        "GET /chores/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      )
    ).toBe("GET /chores/[REDACTED]");

    expect(
      redactSensitiveText(
        "GET /nominations/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      )
    ).toBe("GET /nominations/[REDACTED]");

    expect(
      redactSensitiveText(
        "GET /pay/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      )
    ).toBe("GET /pay/[REDACTED]");

    expect(
      redactSensitiveText(
        "POST /api/pay/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/payment-intent"
      )
    ).toBe("POST /api/pay/[REDACTED]/payment-intent");

    expect(
      redactSensitiveText(
        "GET /booking-requests/verify/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      )
    ).toBe("GET /booking-requests/verify/[REDACTED]");

    expect(
      redactSensitiveText(
        "GET /api/group-bookings/join/verify/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 200 OK"
      )
    ).toBe("GET /api/group-bookings/join/verify/[REDACTED] 200 OK");

    // Subsequent path segments stay intact for the group-join token path too.
    expect(
      redactSensitiveText("/group-bookings/join/verify/aA1_-/extra?keep=true")
    ).toBe("/group-bookings/join/verify/[REDACTED]/extra?keep=true");
  });

  it("redacts token-bearing callback URLs after URL encoding", () => {
    expect(
      redactSensitiveText(
        "GET /login?callbackUrl=%2Fmembership-cancellation%2FabcDEF123_token 302"
      )
    ).toBe("GET /login?callbackUrl=%2Fmembership-cancellation%2F[REDACTED] 302");

    expect(
      redactSensitiveText(
        "GET /login?callbackUrl=%2Fnominations%2F0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 302"
      )
    ).toBe("GET /login?callbackUrl=%2Fnominations%2F[REDACTED] 302");

    expect(
      redactSensitiveText(
        "GET /login?callbackUrl=%2Fpay%2F0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 302"
      )
    ).toBe("GET /login?callbackUrl=%2Fpay%2F[REDACTED] 302");

    expect(
      redactSensitiveText(
        "GET /login?callbackUrl=%2Fbooking-requests%2Fverify%2F0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 302"
      )
    ).toBe(
      "GET /login?callbackUrl=%2Fbooking-requests%2Fverify%2F[REDACTED] 302"
    );

    expect(
      redactSensitiveText(
        "GET /login?callbackUrl=%2Fgroup-bookings%2Fjoin%2Fverify%2F0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 302"
      )
    ).toBe(
      "GET /login?callbackUrl=%2Fgroup-bookings%2Fjoin%2Fverify%2F[REDACTED] 302"
    );
  });

  it("redacts token query parameters and Stripe client secrets in plain text", () => {
    expect(
      redactSensitiveText(
        "GET /reset-password?token=live-reset-token&next=/profile"
      )
    ).toBe("GET /reset-password?token=[REDACTED]&next=/profile");

    expect(
      redactSensitiveText(
        "Stripe returned client_secret=pi_123_secret_liveSecret and whsec_liveWebhookSecret"
      )
    ).toBe(
      "Stripe returned client_secret=[REDACTED] and [REDACTED]"
    );
  });

  it("redacts OAuth callback code and state query parameters in plain text", () => {
    expect(
      redactSensitiveText(
        "GET /api/admin/xero/callback?code=live-code&state=csrf-state 302"
      )
    ).toBe(
      "GET /api/admin/xero/callback?code=[REDACTED]&state=[REDACTED] 302"
    );

    expect(
      redactSensitiveText(
        "https://example.org/api/finance/xero/callback?state=csrf&code=oauth-code"
      )
    ).toBe(
      "https://example.org/api/finance/xero/callback?state=[REDACTED]&code=[REDACTED]"
    );
  });

  // #2683 problem 1: the walk had no depth limit and no circular guard, so a
  // Prisma result with a self-referencing relation overflowed the stack from
  // inside a logging call. Both tests below throw
  // "Maximum call stack size exceeded" against the pre-fix redactor.
  describe("recursion guards", () => {
    function selfReferencingPrismaResult() {
      const member: Record<string, unknown> = {
        id: "cmqdxeu50002101n22w2ivcas",
        firstName: "Jane",
      };
      const familyGroup: Record<string, unknown> = {
        id: "cmp20vk3t00q12345678npunsc",
        memberships: [member],
      };
      member.familyGroup = familyGroup;
      return member;
    }

    it("completes on a circular object and marks the back-reference", () => {
      expect(redactSensitiveJson(selfReferencingPrismaResult())).toEqual({
        id: "cmqdxeu50002101n22w2ivcas",
        firstName: "[REDACTED]",
        familyGroup: {
          id: "cmp20vk3t00q12345678npunsc",
          // Visible, not dropped: the reader is told the branch looped back.
          memberships: ["[Circular]"],
        },
      });
    });

    it("formats a circular object without throwing", () => {
      expect(
        formatRedactedJson(selfReferencingPrismaResult())
      ).toContain('"memberships": [');
      expect(formatRedactedJson(selfReferencingPrismaResult())).toContain(
        "[Circular]"
      );
    });

    it("truncates below the depth cap and says so in the output", () => {
      expect(
        redactSensitiveJson({
          l0: { l1: { l2: { l3: { l4: { l5: { l6: "too deep" } } } } } },
        })
      ).toEqual({
        l0: { l1: { l2: { l3: { l4: { l5: "[TRUNCATED]" } } } } },
      });
    });

    it("keeps a scalar sitting at the cap, truncating only structure", () => {
      // The value is at the same depth as the truncated object above, but a
      // leaf carries the error context a log exists to capture, so only the
      // structure wrapped around one is cut.
      expect(
        redactSensitiveJson({
          l0: { l1: { l2: { l3: { l4: { l5: "still here" } } } } },
        })
      ).toEqual({
        l0: { l1: { l2: { l3: { l4: { l5: "still here" } } } } },
      });
    });

    it("renders a shared object twice rather than calling it circular", () => {
      // Two siblings pointing at one lodge is not a cycle. The guard tracks the
      // ancestor path, so neither copy is blanked — a repeat-visit guard would
      // have replaced the second with "[Circular]" and hidden real context.
      const lodge = { id: "cmp20vk3t00q12345678npunsc", beds: 12 };

      expect(
        redactSensitiveJson({ arrival: { lodge }, departure: { lodge } })
      ).toEqual({
        arrival: { lodge: { id: "cmp20vk3t00q12345678npunsc", beds: 12 } },
        departure: { lodge: { id: "cmp20vk3t00q12345678npunsc", beds: 12 } },
      });
    });

    it("bounds a circular object nested inside a JSON-shaped string", () => {
      // redactSensitiveText and redactSensitiveJson call each other, so the
      // depth has to survive the hop through JSON.parse.
      const payload: Record<string, unknown> = { depth: 1 };
      payload.self = payload;

      expect(() =>
        redactSensitiveJson({ note: '500: {"a":{"b":{"c":1}}}', payload })
      ).not.toThrow();
    });
  });

  // #2683 problem 2 (INV-PRIV-011).
  describe("person fields", () => {
    it("redacts name, address, date of birth, gender and occupation", () => {
      expect(
        redactSensitiveJson({
          memberId: "cmqdxeu50002101n22w2ivcas",
          firstName: "Jane",
          lastName: "Doe",
          streetAddressLine1: "12 Example Street",
          streetCity: "Tokoroa",
          streetPostalCode: "3420",
          postalAddressLine1: "PO Box 5",
          dateOfBirth: "1990-04-01",
          dob: "1990-04-01",
          gender: "FEMALE",
          occupation: "Alpine guide",
        })
      ).toEqual({
        memberId: "cmqdxeu50002101n22w2ivcas",
        firstName: "[REDACTED]",
        lastName: "[REDACTED]",
        streetAddressLine1: "[REDACTED]",
        streetCity: "[REDACTED]",
        streetPostalCode: "[REDACTED]",
        postalAddressLine1: "[REDACTED]",
        dateOfBirth: "[REDACTED]",
        dob: "[REDACTED]",
        gender: "[REDACTED]",
        occupation: "[REDACTED]",
      });
    });

    it("catches person fields under a prefix and in Xero's own casing", () => {
      expect(
        redactSensitiveJson({
          memberFirstName: "Jane",
          actor_last_name: "Doe",
          Contact: {
            FirstName: "Jane",
            LastName: "Doe",
            Addresses: [
              { AddressType: "STREET", AddressLine1: "12 Example Street" },
            ],
          },
        })
      ).toEqual({
        memberFirstName: "[REDACTED]",
        actor_last_name: "[REDACTED]",
        Contact: {
          FirstName: "[REDACTED]",
          LastName: "[REDACTED]",
          Addresses: [
            { AddressType: "STREET", AddressLine1: "[REDACTED]" },
          ],
        },
      });
    });

    it("redacts person fields in JSON-shaped text that does not parse", () => {
      expect(
        redactSensitiveText(
          'failed on {"firstName":"Jane","lastName":"Doe","streetAddressLine1":"12 Example Street","dateOfBirth":"1990-04-01"'
        )
      ).toBe(
        'failed on {"firstName":"[REDACTED]","lastName":"[REDACTED]","streetAddressLine1":"[REDACTED]","dateOfBirth":"[REDACTED]"'
      );
    });

    it("leaves `name` alone — it is lodges, rooms and templates, not people", () => {
      // Deliberate, and load-bearing: xero-operation-summaries.ts reads group
      // names straight out of an already-redacted payload. Person names are
      // caught by the firstName/lastName fragments instead, and a call site
      // that wants to record a person logs the id. See INV-PRIV-011.
      expect(
        redactSensitiveJson({
          lodge: { id: "cmp20vk3t00q12345678npunsc", name: "Alpine Lodge" },
          room: { name: "Bunk Room" },
          defaultGroup: { name: "Members - Adult" },
        })
      ).toEqual({
        lodge: { id: "cmp20vk3t00q12345678npunsc", name: "Alpine Lodge" },
        room: { name: "Bunk Room" },
        defaultGroup: { name: "Members - Adult" },
      });
    });

    it("does not let the new person keys mangle identifiers", () => {
      // The 8+ digit carve-out and the cuid-safety rule still hold with the
      // person keys added; a key that merely CONTAINS an id stays intact.
      expect(
        redactSensitiveJson({
          originalOperationId: "cmqdxeu50002101n22w2ivcas",
          firstNameSourceId: "cmp20vk3t00q12345678npunsc",
        })
      ).toEqual({
        originalOperationId: "cmqdxeu50002101n22w2ivcas",
        // The key contains "firstname", so it is redacted by the denylist —
        // the point of this assertion is that the OTHER id is untouched.
        firstNameSourceId: "[REDACTED]",
      });
    });
  });

  it("redacts OAuth callback code and state in structured query params", () => {
    expect(
      redactSensitiveQueryParams({
        code: "oauth-code",
        state: "csrf-state",
        next: "/admin/xero",
      })
    ).toEqual({
      code: "[REDACTED]",
      state: "[REDACTED]",
      next: "/admin/xero",
    });
  });
});
