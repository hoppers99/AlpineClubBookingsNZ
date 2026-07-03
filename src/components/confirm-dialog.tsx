"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

export type PromptOptions = ConfirmOptions & {
  inputLabel?: string;
  defaultValue?: string;
};

type DialogState = ConfirmOptions & {
  withInput: boolean;
  inputLabel?: string;
};

/**
 * Styled, focus-trapping replacements for window.confirm and window.prompt.
 *
 * Usage:
 *   const { confirm, prompt, confirmDialog } = useConfirm();
 *   ...
 *   if (!(await confirm({ title: "Delete this bed?", destructive: true }))) return;
 *   const reason = await prompt({ title: "Archive?", inputLabel: "Reason" });
 *   if (reason === null) return; // cancelled
 *   ...
 *   return <>{confirmDialog}...</>;
 */
export function useConfirm(): {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  confirmDialog: ReactNode;
} {
  const [options, setOptions] = useState<DialogState | null>(null);
  const [inputValue, setInputValue] = useState("");
  const resolveRef = useRef<((value: boolean | string | null) => void) | null>(
    null,
  );

  const open = useCallback(
    (next: DialogState, defaultValue: string) =>
      new Promise<boolean | string | null>((resolve) => {
        // Only one dialog can be open at a time; a second request while open
        // settles the first as cancelled.
        resolveRef.current?.(next.withInput ? null : false);
        resolveRef.current = resolve;
        setInputValue(defaultValue);
        setOptions(next);
      }),
    [],
  );

  const confirm = useCallback(
    (next: ConfirmOptions) =>
      open({ ...next, withInput: false }, "") as Promise<boolean>,
    [open],
  );

  const prompt = useCallback(
    ({ inputLabel, defaultValue, ...next }: PromptOptions) =>
      open(
        { ...next, withInput: true, inputLabel },
        defaultValue ?? "",
      ) as Promise<string | null>,
    [open],
  );

  const settle = (confirmed: boolean) => {
    if (options?.withInput) {
      resolveRef.current?.(confirmed ? inputValue : null);
    } else {
      resolveRef.current?.(confirmed);
    }
    resolveRef.current = null;
    setOptions(null);
  };

  const confirmDialog = (
    <Dialog
      open={options !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) settle(false);
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{options?.title}</DialogTitle>
          {options?.description ? (
            <DialogDescription>{options.description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {options?.withInput ? (
          <div className="space-y-1.5">
            {options.inputLabel ? (
              <Label htmlFor="confirm-dialog-input">{options.inputLabel}</Label>
            ) : null}
            <Input
              id="confirm-dialog-input"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") settle(true);
              }}
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => settle(false)}>
            {options?.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            type="button"
            variant={options?.destructive ? "destructive" : "default"}
            onClick={() => settle(true)}
          >
            {options?.confirmLabel ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, prompt, confirmDialog };
}
