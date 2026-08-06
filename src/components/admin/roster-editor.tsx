"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ViewOnlyActionButton } from "@/components/admin/view-only-action"
import { useSectionEditState } from "@/hooks/use-section-edit-state"

export interface RosterGuest {
  id: string
  bookingId: string
  bookingGroupLabel: string
  firstName: string
  lastName: string
  ageTier: string
}

export interface RosterAssignment {
  id: string
  choreTemplateId: string
  choreTemplateName: string
  choreDescription: string | null
  choreSortOrder: number
  bookingGuestId: string | null
  guestName: string | null
  guestAgeTier: string | null
  bookingId: string
  status: "SUGGESTED" | "CONFIRMED" | "COMPLETED"
}

export interface RosterTemplate {
  id: string
  name: string
  description: string | null
  recommendedPeopleMin: number
  recommendedPeopleMax: number
  isEssential: boolean
  ageRestriction: string
  conditionalNote: string | null
  minAge: number
  sortOrder: number
  active: boolean
  isDueOnDate: boolean
}

export interface RosterData {
  date: string
  lodgeId: string
  revision: string
  guests: RosterGuest[]
  assignments: RosterAssignment[]
  templates: RosterTemplate[]
  guestHistory: Record<string, Array<{ date: string; choreName: string }>>
  guestCount: number
}

type DraftAssignment = {
  rowKey: string
  assignmentId?: string
  choreTemplateId: string
  bookingGuestId: string
}

type RosterDraft = { assignments: DraftAssignment[] }

const PERMISSION_COPY =
  "Roster not saved. Your account no longer has Lodge edit access. Ask a full admin to update it."
const NETWORK_COPY =
  "Roster not saved because the service could not be reached. Your draft is still here; try Save again."

function draftFromRoster(roster: RosterData): RosterDraft {
  return {
    assignments: roster.assignments.map((assignment) => ({
      rowKey: assignment.id,
      assignmentId: assignment.id,
      choreTemplateId: assignment.choreTemplateId,
      bookingGuestId: assignment.bookingGuestId ?? "",
    })),
  }
}

function assignmentsEqual(a: DraftAssignment[], b: DraftAssignment[]) {
  if (a.length !== b.length) return false
  return a.every((assignment, index) => {
    const other = b[index]
    return assignment.rowKey === other.rowKey &&
      assignment.assignmentId === other.assignmentId &&
      assignment.choreTemplateId === other.choreTemplateId &&
      assignment.bookingGuestId === other.bookingGuestId
  })
}

function rosterDraftIsValid(draft: RosterDraft) {
  return draft.assignments.every((assignment) => assignment.bookingGuestId.length > 0)
}

function groupedGuests(guests: RosterGuest[]) {
  const groups = new Map<string, RosterGuest[]>()
  for (const guest of guests) {
    const key = `${guest.bookingId}\u0000${guest.bookingGroupLabel}`
    const group = groups.get(key) ?? []
    group.push(guest)
    groups.set(key, group)
  }
  return [...groups.entries()].map(([key, members]) => ({
    key,
    label: members[0]?.bookingGroupLabel ?? "Booking group",
    guests: members,
  }))
}

function assignmentSummary(names: string[]) {
  if (names.length === 0) return "No chore assigned"
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  const list = [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name)
  return `${names.length} assignment${names.length === 1 ? "" : "s"}: ${list.join(", ")}`
}

export function RosterEditor({
  roster,
  canEdit,
  saveUrl,
  onRosterUpdate,
  onDirtyChange,
  onEditingChange,
}: {
  roster: RosterData
  canEdit: boolean | undefined
  saveUrl: string
  onRosterUpdate: (roster: RosterData) => void
  onDirtyChange: (dirty: boolean) => void
  onEditingChange: (editing: boolean) => void
}) {
  const [acknowledgeCompletedReset, setAcknowledgeCompletedReset] = useState(false)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const alertRef = useRef<HTMLDivElement>(null)
  const newRowCounter = useRef(0)

  const section = useSectionEditState<RosterDraft>({
    initial: draftFromRoster(roster),
    isDirty: (draft, saved) => !assignmentsEqual(draft.assignments, saved.assignments),
    isValid: rosterDraftIsValid,
    successMessage: "Roster saved. All assignments are now Suggested and ready to confirm.",
    save: async (draft) => {
      setRowErrors({})
      let response: Response
      try {
        response = await fetch(saveUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "save",
            baseRevision: roster.revision,
            acknowledgeCompletedReset,
            assignments: draft.assignments,
          }),
        })
      } catch {
        throw new Error(NETWORK_COPY)
      }

      let body: Partial<RosterData> & {
        error?: string
        code?: string
        details?: { rowKey?: string }
      } = {}
      try {
        body = await response.json()
      } catch {
        if (!response.ok) throw new Error(NETWORK_COPY)
      }
      if (!response.ok) {
        const message = response.status === 403
          ? PERMISSION_COPY
          : response.status >= 500
            ? NETWORK_COPY
            : (body.error ?? NETWORK_COPY)
        if (body.details?.rowKey) {
          setRowErrors({ [body.details.rowKey]: message })
          requestAnimationFrame(() => {
            document.getElementById(`roster-guest-${body.details?.rowKey}`)?.focus()
          })
        }
        throw new Error(message)
      }
      const authoritative = body as RosterData
      onRosterUpdate(authoritative)
      setAcknowledgeCompletedReset(false)
      return draftFromRoster(authoritative)
    },
  })

  useEffect(() => {
    onDirtyChange(section.editing && section.dirty)
    return () => onDirtyChange(false)
  }, [onDirtyChange, section.dirty, section.editing])

  useEffect(() => {
    onEditingChange(section.editing)
    return () => onEditingChange(false)
  }, [onEditingChange, section.editing])

  useEffect(() => {
    if (!section.error) return
    alertRef.current?.focus()
    alertRef.current?.scrollIntoView({ block: "center" })
  }, [section.error])

  useEffect(() => {
    const firstInvalidRow = Object.keys(rowErrors)[0]
    if (!firstInvalidRow) return
    document.getElementById(`roster-guest-${firstInvalidRow}`)?.focus()
  }, [rowErrors])

  const draftAssignments = section.draft?.assignments ?? []
  const guestsById = useMemo(
    () => new Map(roster.guests.map((guest) => [guest.id, guest])),
    [roster.guests],
  )
  const templateById = useMemo(
    () => new Map(roster.templates.map((template) => [template.id, template])),
    [roster.templates],
  )
  const guestGroups = useMemo(() => groupedGuests(roster.guests), [roster.guests])
  const hasCompleted = roster.assignments.some((assignment) => assignment.status === "COMPLETED")

  function startEditing() {
    if (hasCompleted && !window.confirm(
      "This roster has completed chores. Editing is safe to cancel, but a successful Save will clear completion and return every assignment to Suggested. Continue?",
    )) return
    setAcknowledgeCompletedReset(hasCompleted)
    setRowErrors({})
    section.setError("")
    section.startEditing()
  }

  function cancelEditing() {
    section.cancelEditing()
    setAcknowledgeCompletedReset(false)
    setRowErrors({})
  }

  function updateGuest(rowKey: string, bookingGuestId: string) {
    section.setDraft((current) => ({
      assignments: current.assignments.map((assignment) =>
        assignment.rowKey === rowKey ? { ...assignment, bookingGuestId } : assignment,
      ),
    }))
    setRowErrors((current) => {
      const next = { ...current }
      delete next[rowKey]
      return next
    })
  }

  function addPerson(choreTemplateId: string) {
    const rowKey = `new:${roster.revision}:${++newRowCounter.current}`
    section.setDraft((current) => ({
      assignments: [...current.assignments, { rowKey, choreTemplateId, bookingGuestId: "" }],
    }))
    setRowErrors((current) => ({
      ...current,
      [rowKey]: "Choose a person before saving this roster.",
    }))
    requestAnimationFrame(() => document.getElementById(`roster-guest-${rowKey}`)?.focus())
  }

  function removePerson(rowKey: string) {
    section.setDraft((current) => ({
      assignments: current.assignments.filter((assignment) => assignment.rowKey !== rowKey),
    }))
    setRowErrors((current) => {
      const next = { ...current }
      delete next[rowKey]
      return next
    })
  }

  const byTemplate = new Map<string, DraftAssignment[]>()
  for (const assignment of draftAssignments) {
    const rows = byTemplate.get(assignment.choreTemplateId) ?? []
    rows.push(assignment)
    byTemplate.set(assignment.choreTemplateId, rows)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Roster assignments</CardTitle>
              <CardDescription>
                {roster.guestCount} guest{roster.guestCount === 1 ? "" : "s"} staying ·{" "}
                {draftAssignments.length} assignment{draftAssignments.length === 1 ? "" : "s"}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {section.editing ? (
                <>
                  <Button variant="outline" onClick={cancelEditing} disabled={section.saving}>Cancel</Button>
                  <Button
                    onClick={() => void section.save()}
                    disabled={canEdit !== true || section.saving || !section.dirty || !section.valid}
                  >
                    {section.saving ? "Saving…" : "Save roster"}
                  </Button>
                </>
              ) : (
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  onClick={startEditing}
                >
                  Edit roster
                </ViewOnlyActionButton>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div
            ref={alertRef}
            role="alert"
            aria-live="assertive"
            tabIndex={-1}
            className={section.error ? "mb-3 rounded-md bg-destructive/10 px-4 py-3 text-destructive" : "sr-only"}
          >
            {section.error}
          </div>
          <div role="status" aria-live="polite" className={section.success ? "rounded-md bg-success-3 px-4 py-3 text-success-11" : "sr-only"}>
            {section.success}
          </div>
          {hasCompleted && section.editing && (
            <p className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
              Saving this edit will clear completed chore marks and return the whole roster to Suggested. Cancel leaves completion unchanged.
            </p>
          )}
        </CardContent>
      </Card>

      {roster.guests.length === 0 && (
        <Card><CardContent className="py-8 text-center text-muted-foreground">No eligible guests are staying on this date.</CardContent></Card>
      )}

      {roster.templates.map((template) => {
        const assignments = byTemplate.get(template.id) ?? []
        return (
          <Card key={template.id}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-lg text-muted-foreground">{template.sortOrder}.</span>
                  <CardTitle className="text-lg">{template.name}</CardTitle>
                  {!template.isEssential && <Badge variant="outline">Optional</Badge>}
                  {!template.isDueOnDate && <Badge variant="secondary">Not due this night</Badge>}
                </div>
                {section.editing && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => addPerson(template.id)}
                    disabled={canEdit !== true || section.saving || roster.guests.length === 0}
                  >
                    + Add Person
                  </Button>
                )}
              </div>
              {template.description && <CardDescription>{template.description}</CardDescription>}
            </CardHeader>
            <CardContent>
              {assignments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No one assigned.</p>
              ) : (
                <Table>
                  <TableHeader><TableRow><TableHead>Guest</TableHead><TableHead>Age tier</TableHead><TableHead>Status</TableHead>{section.editing && <TableHead className="text-right">Action</TableHead>}</TableRow></TableHeader>
                  <TableBody>
                    {assignments.map((assignment) => {
                      const guest = guestsById.get(assignment.bookingGuestId)
                      const persisted = assignment.assignmentId
                        ? roster.assignments.find((row) => row.id === assignment.assignmentId)
                        : undefined
                      const errorId = `roster-guest-error-${assignment.rowKey}`
                      return (
                        <TableRow key={assignment.rowKey}>
                          <TableCell>
                            {section.editing ? (
                              <div>
                                <select
                                  id={`roster-guest-${assignment.rowKey}`}
                                  value={assignment.bookingGuestId}
                                  onChange={(event) => updateGuest(assignment.rowKey, event.target.value)}
                                  aria-invalid={Boolean(rowErrors[assignment.rowKey])}
                                  aria-describedby={rowErrors[assignment.rowKey] ? errorId : undefined}
                                  disabled={canEdit !== true || section.saving}
                                  className="flex h-9 w-full max-w-[280px] rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                                >
                                  <option value="">Choose a person</option>
                                  {guestGroups.map((group) => (
                                    <optgroup key={group.key} label={group.label}>
                                      {group.guests.map((option) => <option key={option.id} value={option.id}>{option.firstName} {option.lastName}</option>)}
                                    </optgroup>
                                  ))}
                                </select>
                                {rowErrors[assignment.rowKey] && <p id={errorId} className="mt-1 text-sm text-destructive">{rowErrors[assignment.rowKey]}</p>}
                              </div>
                            ) : (guest ? `${guest.firstName} ${guest.lastName}` : persisted?.guestName ?? "Unassigned")}
                          </TableCell>
                          <TableCell>{guest?.ageTier ?? persisted?.guestAgeTier ?? "—"}</TableCell>
                          <TableCell><Badge variant={persisted?.status === "COMPLETED" ? "secondary" : persisted?.status === "CONFIRMED" ? "default" : "outline"}>{persisted?.status ?? "NEW"}</Badge></TableCell>
                          {section.editing && <TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => removePerson(assignment.rowKey)} disabled={canEdit !== true || section.saving}>Remove</Button></TableCell>}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )
      })}

      <Card>
        <CardHeader><CardTitle className="text-base">Chore staffing</CardTitle><CardDescription>Every active chore due this night, in roster order.</CardDescription></CardHeader>
        <CardContent><ul className="space-y-2">
          {roster.templates.filter((template) => template.isDueOnDate).map((template) => {
            const count = (byTemplate.get(template.id) ?? []).filter((assignment) => assignment.bookingGuestId).length
            const staffing = count < template.recommendedPeopleMin
              ? "under"
              : count > template.recommendedPeopleMax
                ? "over"
                : "within"
            const recommendation = template.recommendedPeopleMin === template.recommendedPeopleMax
              ? String(template.recommendedPeopleMin)
              : `${template.recommendedPeopleMin}–${template.recommendedPeopleMax}`
            return <li key={template.id}><span className="font-medium">{template.name}:</span> {count} assigned — <span className="font-medium">{staffing}</span> recommendation {recommendation}</li>
          })}
          {roster.templates.every((template) => !template.isDueOnDate) && <li className="text-muted-foreground">No active chores are due this night.</li>}
        </ul></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Guest assignment check</CardTitle><CardDescription>Every eligible guest, kept with their booking or family group.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {guestGroups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h3 className="mb-2 font-medium">{group.label}</h3>
              <ul className="space-y-1">
                {group.guests.map((guest) => {
                  const choreNames = draftAssignments
                    .filter((assignment) => assignment.bookingGuestId === guest.id)
                    .map((assignment) => templateById.get(assignment.choreTemplateId)?.name ?? "Unknown chore")
                  return <li key={guest.id}><span className="font-medium">{guest.firstName} {guest.lastName}:</span> {assignmentSummary(choreNames)}</li>
                })}
              </ul>
            </section>
          ))}
          {guestGroups.length === 0 && <p className="text-muted-foreground">No eligible guests are staying on this date.</p>}
        </CardContent>
      </Card>
    </div>
  )
}
