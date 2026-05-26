"use client"

import type { ChangeEvent } from "react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "@/lib/member-setup-invite"
import type { ImportResult, ImportRow } from "../_types"
import { parseCsvLine } from "../_utils"

interface MemberImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
  onError: (message: string) => void
}

export function MemberImportDialog({
  open,
  onOpenChange,
  onImported,
  onError,
}: MemberImportDialogProps) {
  const [importRows, setImportRows] = useState<ImportRow[]>([])
  const [importSendInvites, setImportSendInvites] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)

  useEffect(() => {
    if (!open) return
    setImportRows([])
    setImportResult(null)
  }, [open])

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (loadEvent) => {
      const text = loadEvent.target?.result
      if (typeof text !== "string" || !text) return

      const lines = text.split(/\r?\n/).filter((line) => line.trim())
      if (lines.length < 2) {
        onError("CSV must have a header row and at least one data row")
        return
      }

      const headers = parseCsvLine(lines[0]).map((header) =>
        header.toLowerCase().replace(/\s+/g, "")
      )
      const rows: ImportRow[] = []
      for (let index = 1; index < lines.length; index += 1) {
        const values = parseCsvLine(lines[index])
        if (values.length < 3) continue

        const row: ImportRow = { firstName: "", lastName: "", email: "" }
        headers.forEach((header, headerIndex) => {
          const value = values[headerIndex] || ""
          if (header === "firstname" || header === "first_name" || header === "first") {
            row.firstName = value
          } else if (header === "lastname" || header === "last_name" || header === "last") {
            row.lastName = value
          } else if (
            header === "email" ||
            header === "emailaddress" ||
            header === "email_address"
          ) {
            row.email = value
          } else if (
            header === "phone" ||
            header === "phonenumber" ||
            header === "phone_number"
          ) {
            row.phone = value
          } else if (
            header === "dateofbirth" ||
            header === "date_of_birth" ||
            header === "dob"
          ) {
            row.dateOfBirth = value
          } else if (header === "role") {
            row.role = value.toUpperCase()
          }
        })
        if (row.firstName && row.lastName && row.email) rows.push(row)
      }
      setImportRows(rows)
      setImportResult(null)
    }
    reader.readAsText(file)
  }

  const handleImport = async () => {
    setImportLoading(true)
    try {
      const res = await fetch("/api/admin/members/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: importRows,
          sendInvites: importSendInvites,
          autoLinkXero: false,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as ImportResult & { error?: string }
      if (!res.ok) throw new Error(data.error || "Import failed")
      setImportResult(data)
      onImported()
    } catch (err) {
      onError(err instanceof Error ? err.message : "Import failed")
    } finally {
      setImportLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Members from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV with columns: First Name, Last Name, Email, Phone (optional), Date
            of Birth (optional), Role (optional).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="csvFile">CSV File</Label>
            <Input
              id="csvFile"
              type="file"
              accept=".csv"
              onChange={handleFileUpload}
              className="mt-1"
            />
          </div>
          {importRows.length > 0 && !importResult && (
            <div>
              <p className="text-sm font-medium mb-2">{importRows.length} rows parsed</p>
              <div className="max-h-48 overflow-y-auto border rounded text-xs">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>First Name</TableHead>
                      <TableHead>Last Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importRows.slice(0, 10).map((row, index) => (
                      <TableRow key={`${row.email}-${index}`}>
                        <TableCell>{row.firstName}</TableCell>
                        <TableCell>{row.lastName}</TableCell>
                        <TableCell>{row.email}</TableCell>
                        <TableCell>{row.role || "MEMBER"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {importRows.length > 10 && (
                  <p className="text-xs text-slate-500 p-2">
                    ...and {importRows.length - 10} more
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 mt-3">
                <input
                  type="checkbox"
                  id="sendInvites"
                  checked={importSendInvites}
                  onChange={(event) => setImportSendInvites(event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="sendInvites">
                  Send account setup invites ({MEMBER_SETUP_INVITE_TTL_DAYS}-day links)
                </Label>
              </div>
            </div>
          )}
          {importResult && (
            <div className="space-y-2">
              <p className="text-sm">
                <span className="font-medium text-green-700">{importResult.created} created</span>
                , <span className="font-medium text-yellow-700">{importResult.skipped} skipped</span>
                , <span className="font-medium text-red-700">{importResult.errors.length} errors</span>
              </p>
              {importResult.errors.length > 0 && (
                <div className="max-h-32 overflow-y-auto text-xs text-red-600 border border-red-200 rounded p-2">
                  {importResult.errors.map((error, index) => (
                    <p key={`${error.row}-${index}`}>
                      Row {error.row}: {error.errors.join(", ")}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {importRows.length > 0 && !importResult && (
            <Button onClick={handleImport} disabled={importLoading}>
              {importLoading ? "Importing..." : `Import ${importRows.length} Members`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
