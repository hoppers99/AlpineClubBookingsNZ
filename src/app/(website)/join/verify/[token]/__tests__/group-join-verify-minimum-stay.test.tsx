// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupJoinVerifyPageClient } from "@/app/(website)/join/verify/[token]/group-join-verify-page-client";

// #2363. Minimum stay is re-checked when a non-member confirms their emailed
// link, so the rules can have tightened since they asked to join. That answer
// is a 409 of its own — NOT the "group stopped accepting joins" story — and
// the person reading it needs to know nothing was booked and who to ask.

const club = {
  name: "Alpine Club",
  lodgeName: "The Lodge",
} as unknown as Parameters<typeof GroupJoinVerifyPageClient>[0]["club"];

function jsonResponse(data: unknown, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let verifyResponse: () => Response;

beforeEach(() => {
  verifyResponse = () =>
    jsonResponse(
      {
        outcome: "minimum_stay",
        message: "Lodge B weekends: minimum 2 nights",
      },
      409,
    );
  global.fetch = vi.fn(async () => verifyResponse()) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function confirm() {
  fireEvent.click(
    screen.getByRole("button", { name: /Confirm and continue to payment/i }),
  );
}

describe("GroupJoinVerifyPageClient — minimum stay (#2363)", () => {
  it("explains the refusal in plain English and reassures nothing was charged", async () => {
    render(<GroupJoinVerifyPageClient club={club} token={"a".repeat(64)} />);
    await confirm();

    expect(
      await screen.findByText(/shorter than the minimum stay required/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/contact the organiser/i)).toBeInTheDocument();
    expect(screen.getByText(/haven't been charged/i)).toBeInTheDocument();
    // The server's own sentence about the rule is shown too.
    expect(
      screen.getByText("Lodge B weekends: minimum 2 nights"),
    ).toBeInTheDocument();
  });

  it("does not fall back to the generic not-joinable message", async () => {
    render(<GroupJoinVerifyPageClient club={club} token={"a".repeat(64)} />);
    await confirm();

    await screen.findByText(/shorter than the minimum stay required/i);
    expect(
      screen.queryByText(/no longer accepting joins/i),
    ).not.toBeInTheDocument();
  });

  it("still shows the not-joinable message for a plain 409", async () => {
    verifyResponse = () =>
      jsonResponse(
        { outcome: "not_joinable", message: "This group's stay has ended" },
        409,
      );

    render(<GroupJoinVerifyPageClient club={club} token={"a".repeat(64)} />);
    await confirm();

    expect(
      await screen.findByText("This group's stay has ended"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/shorter than the minimum stay required/i),
    ).not.toBeInTheDocument();
  });
});
