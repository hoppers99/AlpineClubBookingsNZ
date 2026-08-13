"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { parseDecimalDollarsToCents } from "@/lib/money-input"
import type { PolicyRule } from "./types"

/** What a refused fixed-fee box says (#2685). */
const FEE_FIELD_ERROR = "Enter a fee in dollars and cents, for example 25.00."

type FeeField = "fixedFeeCents" | "creditFixedFeeCents"

function feeKey(index: number, field: FeeField): string {
  return `${index}:${field}`
}

export function CancellationRulesEditor({
  rules,
  onChange,
  disabled = false,
  onInvalidAmountsChange,
}: {
  rules: PolicyRule[]
  onChange: (rules: PolicyRule[]) => void
  disabled?: boolean
  /**
   * #2685: told whenever a fixed-fee box holds something that is not an amount,
   * so the section around this editor can refuse to save. Without it the stored
   * cents would stay at the PREVIOUS value while the box shows something else.
   */
  onInvalidAmountsChange?: (hasInvalidAmounts: boolean) => void
}) {
  /*
    #2685: the raw text of each fixed-fee box, and the complaint for any box
    whose text is not an amount.

    `rules` holds integer cents, so it cannot also hold a half-typed entry. The
    fee used to be `Math.round((parseFloat(value) || 0) * 100)`, which turned a
    third decimal place into a silent half-cent rounding and anything else into
    a fee of $0.00 — a cancellation charge quietly set to nothing.
  */
  const [feeDrafts, setFeeDrafts] = useState<Record<string, string>>({})
  const [feeErrors, setFeeErrors] = useState<Record<string, string>>({})

  const hasInvalidAmounts = Object.keys(feeErrors).length > 0
  useEffect(() => {
    onInvalidAmountsChange?.(hasInvalidAmounts)
  }, [hasInvalidAmounts, onInvalidAmountsChange])

  function feeValue(index: number, field: FeeField): string {
    const draft = feeDrafts[feeKey(index, field)]
    if (draft !== undefined) return draft
    return ((rules[index]?.[field] ?? 0) / 100).toFixed(2)
  }

  function handleFeeChange(index: number, field: FeeField, value: string) {
    const key = feeKey(index, field)
    setFeeDrafts((prev) => ({ ...prev, [key]: value }))

    // An empty box is a deliberate "no fee", not a mistake.
    const cents = value.trim() === "" ? 0 : parseDecimalDollarsToCents(value)
    if (cents === null) {
      setFeeErrors((prev) => ({ ...prev, [key]: FEE_FIELD_ERROR }))
      return
    }

    setFeeErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    updateRule(index, field, cents)
  }
  function addRule() {
    onChange([
      ...rules,
      {
        daysBeforeStay: 0,
        refundPercentage: 0,
        creditRefundPercentage: 0,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ])
  }
  function removeRule(index: number) {
    // Drop the removed row's drafts and complaints, and shift the rows after it
    // down a place, so a stale error cannot outlive the rule it belonged to.
    const reindex = (prev: Record<string, string>) => {
      const next: Record<string, string> = {}
      for (const [key, value] of Object.entries(prev)) {
        const [rowText, field] = key.split(":")
        const row = Number(rowText)
        if (row === index) continue
        next[feeKey(row > index ? row - 1 : row, field as FeeField)] = value
      }
      return next
    }
    setFeeDrafts(reindex)
    setFeeErrors(reindex)
    onChange(rules.filter((_, i) => i !== index))
  }
  function updateRule(index: number, field: keyof PolicyRule, value: number) {
    onChange(rules.map((r, i) => (i === index ? { ...r, [field]: value } : r)))
  }

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Days Before Stay (min)</TableHead>
            <TableHead>Card Refund %</TableHead>
            <TableHead>Credit Refund %</TableHead>
            <TableHead>Card Fixed Fee ($)</TableHead>
            <TableHead>Credit Fixed Fee ($)</TableHead>
            <TableHead className="w-20"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule, index) => (
            <TableRow key={index}>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <Input
                    type="number"
                    min="0"
                    value={rule.daysBeforeStay}
                    onChange={(e) =>
                      updateRule(index, "daysBeforeStay", parseInt(e.target.value) || 0)
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                  <span className="text-sm text-muted-foreground">days</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={rule.refundPercentage}
                    onChange={(e) =>
                      updateRule(index, "refundPercentage", parseInt(e.target.value) || 0)
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={rule.creditRefundPercentage}
                    onChange={(e) =>
                      updateRule(index, "creditRefundPercentage", parseInt(e.target.value) || 0)
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={feeValue(index, "fixedFeeCents")}
                    onChange={(e) => handleFeeChange(index, "fixedFeeCents", e.target.value)}
                    aria-invalid={feeErrors[feeKey(index, "fixedFeeCents")] ? true : undefined}
                    aria-describedby={
                      feeErrors[feeKey(index, "fixedFeeCents")]
                        ? feeKey(index, "fixedFeeCents")
                        : undefined
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                </div>
                {feeErrors[feeKey(index, "fixedFeeCents")] && (
                  <p
                    id={feeKey(index, "fixedFeeCents")}
                    role="alert"
                    className="text-destructive mt-1 text-sm"
                  >
                    {feeErrors[feeKey(index, "fixedFeeCents")]}
                  </p>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={feeValue(index, "creditFixedFeeCents")}
                    onChange={(e) =>
                      handleFeeChange(index, "creditFixedFeeCents", e.target.value)
                    }
                    aria-invalid={
                      feeErrors[feeKey(index, "creditFixedFeeCents")] ? true : undefined
                    }
                    aria-describedby={
                      feeErrors[feeKey(index, "creditFixedFeeCents")]
                        ? feeKey(index, "creditFixedFeeCents")
                        : undefined
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                </div>
                {feeErrors[feeKey(index, "creditFixedFeeCents")] && (
                  <p
                    id={feeKey(index, "creditFixedFeeCents")}
                    role="alert"
                    className="text-destructive mt-1 text-sm"
                  >
                    {feeErrors[feeKey(index, "creditFixedFeeCents")]}
                  </p>
                )}
              </TableCell>
              <TableCell>
                {!disabled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRule(index)}
                    disabled={rules.length <= 1}
                  >
                    Remove
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!disabled && (
        <Button variant="outline" size="sm" onClick={addRule}>
          Add Rule
        </Button>
      )}
    </div>
  )
}
