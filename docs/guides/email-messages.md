# Email Messages

Audience: Operator

## What it is

Two things in one page: the **shared email variables** every automated email
uses (your club name, sender display name, support and contact addresses, public
URL), and an editor for the **wording of each audited email template** — its
subject and body, with token chips, a live preview, and a per-template restore.
Find it at **Admin → Setup & Configuration → Notifications & Email → Email Messages**
(`/admin/email-messages`). It has no direct sidebar entry — open it from the
**Email Messages** card on the Notifications & Email hub.

This is the *system* email editor. The member-facing booking, payment, and
cancellation copy lives on the separate [Booking Messages](booking-messages.md)
page. Email Messages are edited under the **support** ("Support & System")
permission area; a view-only support role can read but not save.

## When you'd use it

- Your club name, sender display name, support address, or public URL changed and
  every email needs to reflect it.
- The wording of a specific system email (password reset, application approved,
  a booking notice) needs to change from the built-in default.
- You want to preview exactly what a template renders — with real sample values
  substituted for its tokens — before it goes to members.

## Step-by-step

### Update the shared email variables

1. Open **Email Messages**. The top card holds the shared settings.

   ![Email Messages: the shared email-variable fields above, then the Template dropdown with token chips, subject, body, and Save Template / Preview / Restore Default](../images/admin/admin-email-messages.png)

2. Edit any of **Club name**, **Bookings name**, **Sender display name**,
   **Support email**, **Contact email**, or **Public URL**, then click
   **Save Email Settings**. These feed the `{{CLUB_NAME}}`, `{{SUPPORT_EMAIL}}`,
   `{{BASE_URL}}` and related tokens in every template. (Lodge name, travel note,
   and door code are no longer set here — a single-lodge club edits them on
   **Club Identity** under [Site Appearance & Content](appearance.md); a
   multi-lodge club sets them per lodge under **Setup → Lodges** (see
   [Lodges](../multi-lodge/README.md)).)

### Edit a template's wording

1. Choose a template from the **Template** dropdown. The badges show its
   audience (member/admin), key, a one-line trigger summary, and how often it
   sends.
2. Insert any of the **Tokens** chips into the **Subject** or **Body**. A
   highlighted token is **required** — the save is rejected if you remove it
   (for example the sign-in `{{token}}` in a magic-link email).
3. Click **Preview** to render the subject and body with sample values, then
   **Save Template**. Use **Restore Default** to drop your override and return to
   the built-in wording.

### There is no "only if" — write lines that always read correctly

The body is plain text with token substitution and **nothing else**. There is no
`if`, no conditional, no way to show a line only when a value exists. A token
whose value is not applicable to a particular send simply renders as **nothing
at all** — so a line you write as `Door code: {{doorCode}}` prints a bare
`Door code:` to every member staying at a lodge that has no door code.

That is why several tokens are **pre-composed whole lines** rather than bare
values: `{{doorCodeNote}}`, `{{reasonNote}}`, `{{adminNoteLine}}`,
`{{reviewNoteLine}}`, `{{committeeNote}}`, `{{amountRecordedNote}}`,
`{{promoSummary}}`, `{{provisionalGuestsNote}}` and their siblings each render
the **entire** line — label, value and the blank line after it — or nothing
whatsoever. Put one of those tokens on its own, with no label of your own in
front of it, and the email reads correctly whether or not the value exists.

Two consequences worth knowing:

- **Never write a label in front of a `…Note` / `…Line` token.** Writing
  `Admin note: {{adminNoteLine}}` reintroduces the dangling label the token
  exists to prevent.
- **Never annotate a body with instructions to yourself.** Text such as
  `[only when a door code is set]` is not understood by anything — it is
  printed verbatim to the member. Older built-in wording carried such notes;
  they were all removed in v0.13, and the build now refuses any that come back.

For the same reason, **each template covers exactly one outcome.** Where a
message could go two ways there are two templates to edit, not one with a
condition inside it — `Refund Request Approved` and `Refund Request Declined`,
`Booking Review Approved` and `Booking Review Rejected`, and so on. Edit both if
you want both reworded; editing only one leaves the other on its built-in text.

> **Upgrade note (v0.13).** The single *Refund Request Resolved* template was
> split into **Refund Request Approved** and **Refund Request Declined**. If you
> had customised the old one, its wording said "approved" and was also being
> sent to members whose appeal was **declined**. Your old customisation is not
> carried over — both new templates start from the corrected built-in wording,
> and the leftover row is reported at the top of this page as a stale override
> needing cleanup. Re-apply your wording to whichever of the two you want to
> change.

## Settings reference

Shared email variables (top card):

| Field | What it controls | Token it feeds |
| --- | --- | --- |
| Club name | The club's display name | `{{CLUB_NAME}}` |
| Bookings name | The booking-system name | `{{CLUB_BOOKINGS_NAME}}` |
| Sender display name | The "from" name on outbound email | `{{CLUB_EMAIL_FROM_NAME}}` |
| Support email | The support address shown to members | `{{SUPPORT_EMAIL}}` |
| Contact email | The general contact address | `{{CONTACT_EMAIL}}` |
| Public URL | The site's base URL for links | `{{BASE_URL}}` |

Per-template editor:

| Rule | Detail |
| --- | --- |
| Allowed tokens only | Only the chips shown for that template are accepted; unknown `{{tokens}}` are rejected |
| No conditional syntax | Tokens are substituted, nothing more. A value that does not apply renders as nothing — use the pre-composed `…Note` / `…Line` chips for anything optional, and never write `[only when …]` guidance into a body |
| Required tokens | The highlighted chip(s) must stay in the body — removing an essential bearer token (e.g. a `/pay/<token>` or sign-in link), the lodge access details, or the promo explanation on a payment confirmation is refused. A sentence under the chips names the required tokens, and any older token that satisfies the same requirement instead (`{{promoSummary}}` **or** `{{promoAdjustment}}`/`{{discount}}`; `{{doorCodeNote}}` **or** your own label around `{{doorCode}}`) |
| Subject safety | Sensitive token values (e.g. raw tokens) are never allowed in a subject line |
| Override vs default | Saving stores an override; **Restore Default** deletes it and reverts to the built-in text |
| Stale overrides | A count is shown if any stored overrides reference templates that no longer exist (a data-cleanup task) |
| Audit | Template edits are audited (who changed what, when) |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Everything is read-only | Your role has support view, not edit | Ask a full admin for Support & System edit access |
| Save is rejected | You removed a required token, used an unknown token, or put a sensitive token in the subject | Read the reason in the error — it names what the email must show and which tokens do it. Re-add the highlighted token (or one of its listed alternatives); use only the listed chips; keep tokens out of the subject |
| A token shows literally to members | It is misspelled or not allowed for that template | Use the exact chip from the **Tokens** list |
| A line reads "Admin note:" with nothing after it | You wrote your own label in front of a value that was empty for that send | Use the matching pre-composed chip (`{{adminNoteLine}}`, `{{reasonNote}}`, `{{doorCodeNote}}` …) on its own line instead |
| I want the original wording back | An override is in place | Click **Restore Default** for that template |
| The change didn't reach a lodge-specific value | Lodge name/travel note/door code are per-lodge now | Set them in [Lodges](../multi-lodge/README.md), not here |

## Related links

- Back to the [documentation hub](../README.md).
- Hub: [Notifications & Email](notifications.md).
- Sibling guides: [Delivery Rules](notification-rules.md),
  [Recipients](notification-recipients.md),
  [Booking Messages](booking-messages.md) (member-facing booking copy),
  [Email Deliverability](email-deliverability.md).
- Reference: the authoritative template catalogue, approved tokens, and
  subject/body safety rules in
  [`../../src/lib/email-message-registry.ts`](../../src/lib/email-message-registry.ts).
