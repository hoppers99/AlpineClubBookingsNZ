// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { useConfirm } from "@/components/confirm-dialog";

function Harness() {
  const { confirm, prompt, confirmDialog } = useConfirm();
  const [result, setResult] = useState<string>("none");

  return (
    <div>
      {confirmDialog}
      <button
        type="button"
        onClick={async () => {
          const confirmed = await confirm({
            title: "Delete this thing?",
            description: "This cannot be undone.",
            confirmLabel: "Delete",
            destructive: true,
          });
          setResult(confirmed ? "confirmed" : "cancelled");
        }}
      >
        Trigger
      </button>
      <button
        type="button"
        onClick={async () => {
          const reason = await prompt({
            title: "Archive this thing?",
            inputLabel: "Reason",
            defaultValue: "Routine review",
            confirmLabel: "Archive",
          });
          setResult(reason === null ? "prompt-cancelled" : `reason:${reason}`);
        }}
      >
        TriggerPrompt
      </button>
      <output>{result}</output>
    </div>
  );
}

describe("useConfirm", () => {
  it("resolves true when the user confirms", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
    expect(screen.getByText("Delete this thing?")).not.toBeNull();
    expect(screen.getByText("This cannot be undone.")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText("confirmed")).not.toBeNull(),
    );
    expect(screen.queryByText("Delete this thing?")).toBeNull();
  });

  it("resolves false when the user cancels", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Trigger" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.getByText("cancelled")).not.toBeNull(),
    );
    expect(screen.queryByText("Delete this thing?")).toBeNull();
  });
});

describe("useConfirm prompt", () => {
  it("resolves the edited value on confirm", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "TriggerPrompt" }));
    const input = screen.getByLabelText("Reason") as HTMLInputElement;
    expect(input.value).toBe("Routine review");

    fireEvent.change(input, { target: { value: "Custom reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() =>
      expect(screen.getByText("reason:Custom reason")).not.toBeNull(),
    );
  });

  it("resolves null on cancel", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "TriggerPrompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.getByText("prompt-cancelled")).not.toBeNull(),
    );
  });
});
