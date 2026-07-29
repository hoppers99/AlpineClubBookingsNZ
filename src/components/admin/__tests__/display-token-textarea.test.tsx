// @vitest-environment jsdom

import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DisplayTokenTextarea,
  type DisplayConfigSource,
} from "@/components/admin/display-token-textarea";

// #2248: the shared token assistant. The load-bearing promise is CARET-AWARE
// insertion — the token lands where the caret was (replacing any selection),
// never appended — plus the decided behaviours: live config values as row
// descriptions (decision 1), an unset key insertable with a warning naming the
// exact wall placeholder (decision 3), and an invalid key inert rather than
// silently inserted.

function readySource(
  entries: DisplayConfigSource["entries"] = [
    { key: "door-pin", value: "4821" },
    { key: "wifi-code", value: "alpine1234" },
  ]
): DisplayConfigSource {
  return { status: "ready", lodgeName: "Ruapehu Lodge", entries };
}

function Harness({
  mode = "html",
  initial = "",
  configSource,
  // `disabled` is a required prop on the component (#2065 house convention:
  // access decisions are stated explicitly, never truthy-defaulted); the
  // harness supplies the "editable" default only for test brevity.
  disabled = false,
}: {
  mode?: "html" | "css";
  initial?: string;
  configSource?: DisplayConfigSource;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <DisplayTokenTextarea
      id="field"
      label="Footer HTML"
      mode={mode}
      value={value}
      onValueChange={setValue}
      disabled={disabled}
      configSource={configSource}
    />
  );
}

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText("Footer HTML");
}

function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: /insert token/i }));
}

function searchInput(): HTMLInputElement {
  return screen.getByRole("combobox") as HTMLInputElement;
}

/** Place the caret (or a selection) and let the component capture it. */
function placeCaret(start: number, end = start) {
  const el = textarea();
  el.focus();
  el.setSelectionRange(start, end);
  fireEvent.select(el);
}

describe("DisplayTokenTextarea", () => {
  beforeEach(() => {
    // cmdk scrolls the active item into view; jsdom has no layout engine.
    Element.prototype.scrollIntoView = vi.fn();
    // cmdk observes its list size; jsdom ships no ResizeObserver.
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(cleanup);

  it("lists the standard tokens and the lodge's config keys with their live values", () => {
    render(<Harness configSource={readySource()} />);
    openPicker();

    expect(screen.getByText("{{lodge-name}}")).not.toBeNull();
    expect(screen.getByText("{{display-date}}")).not.toBeNull();
    // Decision 2: the group is named after the preview lodge.
    expect(
      screen.getByText("Ruapehu Lodge config keys · 2 saved")
    ).not.toBeNull();
    expect(screen.getByText("{{config:wifi-code}}")).not.toBeNull();
    // Decision 1: the saved value is the row description, unmasked.
    expect(screen.getByText("alpine1234")).not.toBeNull();
    expect(screen.getByText("4821")).not.toBeNull();
  });

  it("inserts at the caret, not at the end, and restores focus with the run selected", async () => {
    render(<Harness initial="AB" configSource={readySource()} />);
    placeCaret(1);
    openPicker();

    fireEvent.click(screen.getByText("{{lodge-name}}"));

    await waitFor(() => expect(textarea().value).toBe("A{{lodge-name}}B"));
    expect(document.activeElement).toBe(textarea());
    // The inserted run is left selected so it can be typed over or kept.
    expect(textarea().selectionStart).toBe(1);
    expect(textarea().selectionEnd).toBe(1 + "{{lodge-name}}".length);
    // The insert is announced for screen-reader users.
    expect(screen.getByRole("status").textContent).toContain(
      "Inserted {{lodge-name}}"
    );
  });

  it("replaces a selection instead of appending", async () => {
    render(<Harness initial="hello world" configSource={readySource()} />);
    placeCaret(0, 5);
    openPicker();

    fireEvent.click(screen.getByText("{{config:wifi-code}}"));

    await waitFor(() =>
      expect(textarea().value).toBe("{{config:wifi-code}} world")
    );
  });

  it("appends at the end when the field has never been touched", async () => {
    render(<Harness initial="abc" configSource={readySource()} />);
    openPicker();

    fireEvent.click(screen.getByText("{{lodge-name}}"));

    await waitFor(() => expect(textarea().value).toBe("abc{{lodge-name}}"));
  });

  it("offers a typed unset key with a warning naming the exact wall placeholder", async () => {
    render(<Harness configSource={readySource()} />);
    openPicker();

    fireEvent.change(searchInput(), { target: { value: "kitchen-wifi" } });

    // Decision 3: insertable, consequence stated up front.
    expect(screen.getByText("{{config:kitchen-wifi}}")).not.toBeNull();
    expect(screen.getByText("Insert as a new config key")).not.toBeNull();
    const warning = screen.getByText(/No value saved on Ruapehu Lodge/);
    expect(warning.textContent).toContain("⟨config:kitchen-wifi?⟩");

    fireEvent.keyDown(searchInput(), { key: "Enter" });
    await waitFor(() =>
      expect(textarea().value).toBe("{{config:kitchen-wifi}}")
    );
  });

  it("keeps an invalid typed key inert, with the key rules and a suggestion", () => {
    render(<Harness configSource={readySource()} />);
    openPicker();

    fireEvent.change(searchInput(), { target: { value: "Wi-Fi Code!" } });

    const row = screen.getByText("{{config:Wi-Fi Code!}}");
    expect(
      row.closest("[cmdk-item]")?.getAttribute("aria-disabled")
    ).toBe("true");
    const note = screen.getByText(/lower-case letters, digits and hyphens/);
    expect(note.textContent).toContain("wi-fi-code");

    // Enter must NOT insert something the renderer will never match.
    fireEvent.keyDown(searchInput(), { key: "Enter" });
    expect(textarea().value).toBe("");
  });

  it("explains an empty config group and where keys come from", () => {
    render(<Harness configSource={readySource([])} />);
    openPicker();

    expect(
      screen.getByText("Ruapehu Lodge config keys · none saved")
    ).not.toBeNull();
    expect(
      screen.getByText(/Config keys are the lodge's own values/)
    ).not.toBeNull();
  });

  it("in CSS mode lists listDisplayCssTokens() and inserts the var(--…) usage", async () => {
    render(<Harness mode="css" initial=".x { color:  }" />);
    placeCaret(12);
    openPicker();

    expect(screen.getByText("Display palette · always defined")).not.toBeNull();
    expect(screen.getByText("Club theme · follows the website")).not.toBeNull();

    fireEvent.click(screen.getByText("--display-accent"));

    await waitFor(() =>
      expect(textarea().value).toBe(".x { color: var(--display-accent) }")
    );
  });

  it("Escape closes the picker and returns focus to the textarea at the old caret", async () => {
    render(<Harness initial="abcdef" configSource={readySource()} />);
    placeCaret(3);
    openPicker();
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.keyDown(searchInput(), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(textarea());
    expect(textarea().selectionStart).toBe(3);
    expect(textarea().value).toBe("abcdef");
  });

  it("Escape on the TRIGGER of an open picker closes the picker only, without propagating", async () => {
    // Focus can rest on the trigger with the popover open (Shift+Tab from the
    // search input). Escape there must close the picker — and must not reach
    // an enclosing container (in the app, the zone drawer's Sheet).
    const outerKeyDown = vi.fn();
    render(
      <div onKeyDown={outerKeyDown}>
        <Harness initial="abc" configSource={readySource()} />
      </div>
    );
    placeCaret(2);
    openPicker();
    expect(screen.queryByRole("dialog")).not.toBeNull();

    const trigger = screen.getByRole("button", { name: /insert token/i });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Closed the picker only: nothing bubbled to the surrounding container,
    // and the field is untouched with focus back at the old caret.
    expect(outerKeyDown).not.toHaveBeenCalled();
    expect(textarea().value).toBe("abc");
    expect(document.activeElement).toBe(textarea());
    expect(textarea().selectionStart).toBe(2);
  });

  it("marks the assistant root for the Sheet Escape guard only while open", () => {
    // The zone drawer's Sheet matches `closest([data-display-token-popover])`
    // in onEscapeKeyDown; the marker must cover the trigger too (F1) and must
    // vanish when closed so Escape can dismiss the drawer normally.
    render(<Harness configSource={readySource()} />);
    const trigger = screen.getByRole("button", { name: /insert token/i });
    expect(trigger.closest("[data-display-token-popover]")).toBeNull();

    openPicker();
    expect(trigger.closest("[data-display-token-popover]")).not.toBeNull();
    expect(
      searchInput().closest("[data-display-token-popover]")
    ).not.toBeNull();

    fireEvent.keyDown(searchInput(), { key: "Escape" });
    expect(trigger.closest("[data-display-token-popover]")).toBeNull();
  });

  it("announces a repeat insert of the same token again", async () => {
    render(<Harness configSource={readySource()} />);
    openPicker();
    fireEvent.click(screen.getByText("{{lodge-name}}"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Inserted {{lodge-name}}"
      )
    );
    const first = screen.getByRole("status").textContent;

    openPicker();
    // Scoped to the dialog: the textarea itself now also contains the token.
    fireEvent.click(
      within(screen.getByRole("dialog")).getByText("{{lodge-name}}")
    );

    // The alternating invisible suffix makes the second announcement a real
    // state change — identical strings would bail out of the update and leave
    // screen readers silent on the repeat insert.
    await waitFor(() => {
      const second = screen.getByRole("status").textContent;
      expect(second).toContain("Inserted {{lodge-name}}");
      expect(second).not.toBe(first);
    });
  });

  it("links the trigger to the open popover via aria-controls", () => {
    render(<Harness configSource={readySource()} />);
    const trigger = screen.getByRole("button", { name: /insert token/i });
    expect(trigger.getAttribute("aria-controls")).toBeNull();

    openPicker();
    const dialog = screen.getByRole("dialog");
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    expect(dialog.id).not.toBe("");
  });

  it("disables the trigger (not hides it) for a view-only admin", () => {
    render(<Harness disabled configSource={readySource()} />);
    const trigger = screen.getByRole("button", { name: /insert token/i });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
  });
});
