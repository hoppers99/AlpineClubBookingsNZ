// @vitest-environment jsdom

import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddressAutocomplete } from "@/components/address-autocomplete";

function AddressAutocompleteHarness() {
  const [value, setValue] = useState("");

  return (
    <>
      <AddressAutocomplete
        id="address-line-1"
        onAddressSelected={vi.fn()}
        onChange={setValue}
        value={value}
      />
      <output data-testid="address-value">{value}</output>
    </>
  );
}

describe("AddressAutocomplete fallback behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["disabled module", 404],
    ["missing credentials", 503],
    ["rate limiting", 429],
    ["upstream failure", 502],
  ])("keeps manual entry usable after %s response", async (_label, status) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Address lookup unavailable" }), {
          status,
        }),
      ),
    );

    render(<AddressAutocompleteHarness />);

    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "123 Main Road" } });

    expect(screen.getByTestId("address-value").textContent).toBe(
      "123 Main Road",
    );

    await waitFor(() => {
      expect(
        screen.getByText("Address lookup unavailable; enter address manually."),
      ).toBeTruthy();
    });
    expect(input).toHaveProperty("value", "123 Main Road");
  });
});
