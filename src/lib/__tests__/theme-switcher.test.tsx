// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeSwitcher } from "@/components/theme-switcher";

const { setThemeMock, useThemeMock } = vi.hoisted(() => ({
  setThemeMock: vi.fn(),
  useThemeMock: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: useThemeMock,
}));

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useThemeMock.mockReturnValue({
      setTheme: setThemeMock,
      theme: "system",
    });
  });

  it("renders an accessible Light, Dark, and Follow system radiogroup", () => {
    render(<ThemeSwitcher label="Display mode" />);

    expect(
      screen.getByRole("radiogroup", { name: "Display mode" })
    ).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Light" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Dark" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Follow system" })).toBeTruthy();
  });

  it("marks the current browser theme choice and updates next-themes", async () => {
    useThemeMock.mockReturnValue({
      setTheme: setThemeMock,
      theme: "dark",
    });

    render(<ThemeSwitcher />);

    await waitFor(() => {
      expect(
        screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")
      ).toBe("true");
    });

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    fireEvent.click(screen.getByRole("radio", { name: "Follow system" }));

    expect(setThemeMock).toHaveBeenNthCalledWith(1, "light");
    expect(setThemeMock).toHaveBeenNthCalledWith(2, "system");
  });

  it("falls back to Follow system before a valid stored theme is available", () => {
    useThemeMock.mockReturnValue({
      setTheme: setThemeMock,
      theme: undefined,
    });

    render(<ThemeSwitcher />);

    expect(
      screen
        .getByRole("radio", { name: "Follow system" })
        .getAttribute("aria-checked")
    ).toBe("true");
  });
});
