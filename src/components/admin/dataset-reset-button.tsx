"use client"

import { RotateCcw } from "lucide-react"
import { Button, type ButtonProps } from "@/components/ui/button"

const DEFAULT_DESCRIPTION =
  "Search, filters, sort, and page are already at their defaults."

interface DatasetResetButtonProps
  extends Omit<ButtonProps, "children" | "disabled" | "onClick" | "type"> {
  disabled: boolean
  onReset: () => void
  defaultDescription?: string
}

/**
 * The canonical, always-rendered Reset action for page-level datasets.
 *
 * A native disabled button communicates the default state to assistive
 * technology while the visible label keeps the action discoverable. Callers
 * own the exact dataset dirty check and reset transaction.
 */
export function DatasetResetButton({
  disabled,
  onReset,
  defaultDescription = DEFAULT_DESCRIPTION,
  variant = "outline",
  size = "sm",
  ...props
}: DatasetResetButtonProps) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      onClick={onReset}
      aria-label={disabled ? `Reset. ${defaultDescription}` : "Reset"}
      {...props}
    >
      <RotateCcw aria-hidden="true" />
      Reset
    </Button>
  )
}
