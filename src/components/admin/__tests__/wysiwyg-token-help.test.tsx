// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WysiwygEditor } from "@/components/admin/page-content-panel";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

describe("WysiwygEditor token help", () => {
  it("renders no token help button when no context is set", () => {
    render(<WysiwygEditor value="<p>Example</p>" onChange={() => {}} />);

    expect(screen.queryByRole("button", { name: "Token help" })).toBeNull();
  });

  it("opens a dialog listing only the context's tokens", () => {
    render(
      <WysiwygEditor
        value="<p>Example</p>"
        onChange={() => {}}
        tokenHelpContext="lodge-instructions"
      />,
    );

    // Toolbar buttons act on mouse down so the editor selection survives.
    fireEvent.mouseDown(screen.getByRole("button", { name: "Token help" }));

    // Lodge instructions support text tokens only.
    expect(screen.getByText("club-name")).toBeTruthy();
    expect(screen.getByText("lodge-capacity")).toBeTruthy();
    expect(screen.queryByText("contact-form")).toBeNull();
    expect(screen.queryByText("photo-gallery")).toBeNull();
  });

  it("lists embed tokens for the page content body context", () => {
    render(
      <WysiwygEditor
        value="<p>Example</p>"
        onChange={() => {}}
        tokenHelpContext="page-content-body"
      />,
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: "Token help" }));

    expect(screen.getByText("contact-form")).toBeTruthy();
    expect(screen.getByText("photo-gallery")).toBeTruthy();
    expect(screen.getByText("club-name")).toBeTruthy();
  });
});
