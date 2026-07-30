// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WebsiteLogo } from "@/components/website-logo";

const DATA_URL = "data:image/png;base64,AAAA";
const IMAGE_URL = "/api/images/abc123";

describe("WebsiteLogo source precedence (#2322)", () => {
  it("prefers the served-image URL over an inlined data URI", () => {
    render(
      <WebsiteLogo
        label="Alpine Sports Club"
        logoUrl={IMAGE_URL}
        logoDataUrl={DATA_URL}
      />,
    );

    const img = screen.getByAltText("Alpine Sports Club") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(IMAGE_URL);
  });

  it("falls back to the data URI when no URL is stored", () => {
    // Deployments that have not re-uploaded their logo must keep rendering.
    render(<WebsiteLogo label="Alpine Sports Club" logoDataUrl={DATA_URL} />);

    const img = screen.getByAltText("Alpine Sports Club") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(DATA_URL);
  });

  it("renders the text label when neither logo form is set", () => {
    render(<WebsiteLogo label="Alpine Sports Club" />);

    expect(screen.queryByAltText("Alpine Sports Club")).toBeNull();
    expect(screen.getByText("Alpine Sports Club")).toBeTruthy();
  });

  it("treats an empty-string URL as absent rather than rendering a broken image", () => {
    render(
      <WebsiteLogo label="Alpine Sports Club" logoUrl="" logoDataUrl={DATA_URL} />,
    );

    const img = screen.getByAltText("Alpine Sports Club") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(DATA_URL);
  });
});
