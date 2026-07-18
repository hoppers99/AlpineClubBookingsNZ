// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODULE_SETTINGS } from "@/config/modules";
import { GoogleSecurityCard } from "@/components/admin/google-security-card";

// Self-contained Login & Security card (#2035). The enable toggle persists the
// googleLogin module column through the existing PUT /api/admin/modules route,
// and a credentials-missing warning shows when enabled without secrets.
describe("GoogleSecurityCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reflects the current module state", () => {
    render(
      <GoogleSecurityCard
        moduleSettings={{ ...DEFAULT_MODULE_SETTINGS, googleLogin: true }}
        credentialsConfigured
      />,
    );
    const toggle = screen.getByRole("checkbox", { name: /enable google sign-in/i });
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });

  it("warns when enabled without credentials configured", () => {
    render(
      <GoogleSecurityCard
        moduleSettings={{ ...DEFAULT_MODULE_SETTINGS, googleLogin: true }}
        credentialsConfigured={false}
      />,
    );
    expect(screen.getByText(/Google credentials not configured/i)).toBeTruthy();
  });

  it("does not warn when disabled without credentials", () => {
    render(
      <GoogleSecurityCard
        moduleSettings={{ ...DEFAULT_MODULE_SETTINGS, googleLogin: false }}
        credentialsConfigured={false}
      />,
    );
    expect(screen.queryByText(/Google credentials not configured/i)).toBeNull();
  });

  it("persists the enable toggle through PUT /api/admin/modules with the full settings", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    render(
      <GoogleSecurityCard
        moduleSettings={{ ...DEFAULT_MODULE_SETTINGS, googleLogin: false }}
        credentialsConfigured
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: /enable google sign-in/i }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/modules");
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(String(init?.body));
    expect(body.settings.googleLogin).toBe(true);
    expect(Object.keys(body.settings).sort()).toEqual(
      Object.keys(DEFAULT_MODULE_SETTINGS).sort(),
    );
  });
});
