# Audit Log

Audience: Operator

## What it is

A searchable timeline of everything the system records: member, booking,
finance, payment, Xero, admin, security, and privacy activity, each with the
actor who did it, the member it affected, the outcome, and (when present) the
request ID, IP, and retention class. Find it at **Admin → Monitoring & Support → Audit Log**
(`/admin/audit-log`).

The audit log is read-only — you can filter, search, expand a row for its full
detail, and drill through to the member or record it references, but you cannot
edit or delete an entry. Retention and optional archival are governed by the
[`AUDIT_RETENTION_ARCHIVE_RUNBOOK.md`](../AUDIT_RETENTION_ARCHIVE_RUNBOOK.md).

## When you'd use it

- A member asks "who changed my booking / membership / family group, and when?"
- You're investigating a payment, refund, or Xero sync that behaved unexpectedly
  and want the exact sequence of events.
- A security or privacy review needs the record of who accessed or acted on a
  member's data.

## Step-by-step

### Find the events you need

1. Go to **Admin → Audit Log**. The most recent events load first, 25 per page.

   ![Audit Log with the filter bar (event type, category, member, date range, outcome, severity, entity, search) above the paged event table](../images/admin/admin-audit-log.png)

2. Narrow with the filter bar: pick an **Event Type** or **Category**, search a
   **Member** (and set **Member Scope** to *Involves*, *Actor*, or *Subject*),
   set a **date range**, or filter by **Outcome**, **Severity**, or **Entity**.
   The free-text **Search** matches the action, summary, request ID, or entity.
3. Click a row to expand it for the **Details**, **Metadata**, request ID, IP,
   user agent, retention class, and every drill-down target. Use **Clear** to
   reset all filters.

## Settings reference

The audit log has no editable settings. Its filters:

| Filter | What it does |
| --- | --- |
| Event Type | Restrict to one recorded event action |
| Category | One of account, booking, payment, family, admin, security, lodge, xero, communication, privacy, system |
| Member + Member Scope | A specific member, matched as the actor, the subject, or either (*Involves*) |
| Date range | From/To, with the standard presets |
| Outcome | The recorded result (e.g. success/failure), from the events present |
| Severity | The recorded severity, from the events present |
| Entity | The record type the event touched |
| Search | Free text over action, summary, request ID, and entity |

Each row shows the timestamp, the category/severity/outcome badges, the summary
and machine `action`, the actor, the affected member (subject), the entity, and
primary drill-down links. Expanding a row reveals the request ID, IP, user
agent, **retention class**, raw details, and JSON metadata.

### Booking-policy entries

From this release, a `group-discount.update`, `cancellation-policy.update`,
`booking-period.update`, or `minimum-stay-policy.update` entry recorded **from
the admin screens** always reflects a real change: the Booking Policies forms
keep **Save** disabled until the form actually differs from what is stored, so
opening **Edit** and saving without touching anything can no longer write an
entry.

The same now holds for the row-level **Activate** / **Deactivate** buttons on
booking periods and minimum-stay policies, which write through the same two
`*.update` actions. Those are not form saves — they are one-click writes — so
they were never covered by the Save gate; a quick double-click used to send the
same new value twice and record the second as an update whose `before` and
`after` were identical. Each button is now disabled for the round trip and
guarded against a repeat click, so one click is one entry.

The red **Delete** button on a minimum-stay policy records
`minimum-stay-policy.delete`, not an `*.update`. It is a **soft** delete: the
policy is marked inactive and stops applying, but the row is kept and stays
listed in the admin screen, where **Activate** can bring it back. Read the
entry as "taken out of use", not as "erased".

Two caveats. Entries recorded *before* this release may still be no-ops, so
treat an older pair of identical `before`/`after` values as "nothing changed"
rather than as a mystery. And the guarantee is a property of the admin screens,
not of the write routes — a script or integration calling the API directly with
`bookings:edit` can still submit an unchanged body and get an entry.

### Member-guest entries (#2308 / #2388)

The "+ Add Member Guest" feature writes four `privacy`-category actions. Two of
them contain things you should know are there before you give somebody audit
access.

| Action | Written when | What it contains |
| --- | --- | --- |
| `member_guest.resolve_email` | Every time a member looks another member up by email address in the booking wizard — including when nothing was found, and when they hit the speed limit | **The full email address they typed**, and how many people it matched. The address is stored deliberately: a domain alone cannot tell probing one household from probing forty. Kept for two years (`sensitive_access`) |
| `member_guest.search` | Every name-search keystroke batch, where the club turned name search on — including fragments too short to run a query, and blocked ones | **The name fragment they typed** (up to 64 characters), the number of results, and whether the list was truncated. Kept for ninety days (`diagnostic_high_volume`), because this is the high-volume one |
| `member_guest.add_refused` | Every time a member is refused when adding somebody outside their own family group | The member who tried and the member they tried to add. Kept for two years |
| `member_guest.repeated_refusal` | When one member has been refused several times in 24 hours against the **same** other member. **Once per pair per 24 hours** — it is raised on the crossing, not on every refusal after it | Both members, and the count at the moment it was raised. Severity **important**, so it stands out |

**Be clear about the first two with your committee.** Anyone who can read the
audit log can see the email addresses and names members typed into the finder.
That is the price of being able to detect somebody working through the roll, and
it is why the search settings ship off.

**A `member_guest.repeated_refusal` entry is not an alarm and nothing was
blocked.** By an explicit owner decision, repeated refusals are recorded for a
person to look at and never acted on automatically: a member trying five
different weekends to find one that suits a friend produces exactly the same
pattern as somebody probing, and only a human who knows both people can tell
them apart. Treat it as a conversation to have if it keeps happening.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No entries found | The active filters exclude everything | Click **Clear**, then re-apply one filter at a time |
| An old event is missing | It aged out under the retention policy (or was archived) | See the [audit retention & archive runbook](../AUDIT_RETENTION_ARCHIVE_RUNBOOK.md) |
| A row won't expand | It has no extra detail (no metadata, request, or IP) | Nothing to show — the summary row is the whole record |
| Actor shows as "System" | The event was performed by a job or deploy, not a person | Expected for cron/webhook/bootstrap activity |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling monitoring guides: [System Health](health.md),
  [Stuck States](stuck-states.md), [Background Jobs](background-jobs.md).
- Reference: [audit retention & archive runbook](../AUDIT_RETENTION_ARCHIVE_RUNBOOK.md).
