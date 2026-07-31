# Promo Codes

Audience: Operator

## What it is

The page for creating and managing discount codes and vouchers — percentage
off, a fixed amount off, free nights, or a fixed nightly price — with usage
caps, date windows, member restrictions, and optional Xero accounting codes.
Find it at **Admin → Rates & Policies → Promo Codes**
(`/admin/promo-codes`).

Managing promo codes needs **bookings edit** access. The create/edit form can
also pull your Xero chart of accounts and items; if your role has no finance
access, those fields fall back to plain text entry. Money is entered in dollars
and stored as integer cents; dates are NZ date-only lodge nights.

## When you'd use it

- You are running an early-bird or seasonal discount and need a code members can
  enter at booking.
- You want to give specific members a personal voucher (for example free nights
  as a prize or thank-you).
- You want to cap how many times a code can be used, or restrict it to certain
  dates, lodges, or members.
- You need to deactivate, archive, or restore a code.

## Step-by-step

### Review existing codes

1. Go to **Admin → Rates & Policies → Promo Codes**. Each active code is a card
   showing the code, its type badge, its benefit, the redemptions that gave a
   benefit, the members who benefited, and validity, plus **Deactivate**,
   **Edit**, and **Delete**/**Archive** actions. When a code has been applied to
   bookings it did nothing for, the card says so underneath the redemptions
   figure — a useful hint that the code is misconfigured for the stays people
   are actually booking.

   ![Promo Codes page: active code cards (FLAT50, STAY3GET1, MATE20, WINTER15) with type badges, benefit summaries, and an Add Promo Code button](../images/admin/admin-promo-codes.png)

2. Open the **Archived Promo Codes** section at the bottom to see and restore
   archived codes.

### Create a code

1. Click **Add Promo Code**.
2. Enter a **Code** (auto-uppercased, for example `WINTER20`) and an optional
   **Description**.
3. Choose the **Discount Type** and fill the fields it reveals:
   - **Percentage Off** — a percentage per individual (1–100).
   - **Fixed Amount Off** — an amount off per individual (NZD).
   - **Free Nights** — free nights per individual, with an optional lifetime cap.
   - **Fixed Price per Night** — a fixed nightly price per eligible individual,
     used either as a set price or a cap.
4. Set any **Usage limits** (guests per booking, unique members, uses per
   member, total redemptions — leave blank for no limit) and any date windows.
   Only an application that actually delivered a benefit — money off, a price
   change, or a subsidised night — counts toward these limits. If a member
   applies the code and it works out to nothing for their booking (a nightly
   cap that never bites, a percentage off nights that are already free), the
   application is still recorded in the redemptions report but uses up none of
   their allowance, and none of the code's.
5. Set the flags — **Members only**, **Member guests only**, **Active** — and,
   if you use Xero, the optional item/account codes. Optionally restrict the
   code to specific lodges (multi-lodge) or assign it to specific members.
6. Click **Create Promo Code**.

### Deactivate, archive, or restore

1. Use **Deactivate** to stop a code being used without deleting it. A code
   that has been redeemed is **archived** rather than deleted (its history is
   kept); use **Restore** from the Archived section to bring it back.

### See who redeemed a code

1. Click **Redemptions** on any code (active, archived, or an internal
   work-party code) to open its redemption report. This view is available to
   view-only bookings admins as well — it changes nothing.
2. The tiles at the top summarise **total redemptions** (with progress toward
   the total-redemptions cap when one is set), **unique members**, **total
   discounted** (the summed discount), and **free nights used**. This report
   deliberately lists *every* application of the code, including any that
   delivered no benefit; those rows show a zero discount and, unlike the figures
   on the code's card, consume none of the usage limits.
3. Filter by **redeemed date range** (quick presets or custom dates) and, on a
   multi-lodge site, by **lodge**. The tiles and table recompute for the filter;
   the tiles also show the all-time figure alongside the filtered one.
4. Each table row is one booking's redemption: when it was redeemed, the member
   (name and email, linking to their profile), the booking reference (linking to
   the booking), the lodge, the stay dates and nights, the eligible guest count,
   the discount, and the free nights used. A **Use #N** badge marks a member's
   second or later use of the code.
5. Bookings that split the promo across several members show an expander;
   open it to see each member's share of the discount and free nights.
6. Click **CSV** to download the full filtered list. The export is fetched in a
   single request and is recorded in the audit log as a privacy event (the
   applied filters and the row count only — never the redemption rows
   themselves); ordinary paginated browsing of the report is not audited.

## Settings reference

| Setting | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Code | The text members enter | — | Required; auto-uppercased |
| Discount Type | Percentage / Fixed Amount / Free Nights / Fixed Price per Night | Percentage | Reveals type-specific fields |
| Percentage / Amount / Free nights / Fixed nightly price | The discount value | — | Percent 1–100; money in dollars stored as cents |
| Fixed nightly mode | Set everyone to this price, or use as a cap | Cap only | Fixed-price type only |
| Max nightly value covered | Cap the discount applied to any one night | unlimited | Percentage and Free Nights only |
| Usage limits | Guests/booking, unique members, uses/member, total redemptions | unlimited | Blank = no limit; only applications that gave a benefit count |
| Valid From / Until, Check-in From / Until | When the code and eligible stays apply | none | NZ date-only |
| Members only / Member guests only | Restrict who the code applies to | off | — |
| Active | Whether the code can be used now | on | — |
| Xero Item Code / Account Code | Post the discount line to a specific Xero item/account | none | Item's mapped account wins over the account code |
| Restrict to Lodges | Limit redemption to chosen lodges | all lodges | Multi-lodge only |
| Assign to Specific Members | Limit use to named members, with a scope choice | none | Own-nights-only or whole booking |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The page is read-only | Your admin role is view-only for bookings | Ask a full admin for bookings edit access |
| Xero item/account fields are plain text boxes | Your role has no finance access, or Xero data failed to load | Enter the codes manually, or ask a finance admin — the code still works |
| Delete became Archive | The code has redemptions and its history must be kept | Use Archive; **Restore** it later from the Archived section |
| A code won't apply to a booking | It is inactive, expired, capped out, or restricted to other members/lodges/dates | Check the Active flag, date windows, usage caps, and any member/lodge restriction |
| No promo codes appear | None have been created (the demo seed ships none) | Click **Add Promo Code** to create one |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Book on Behalf](book.md), [Booking Policies](booking-policies.md),
  [Seasons](seasons.md), [Payments](payments.md).
- Reference: promo application in the
  [booking/payment flow](../ARCHITECTURE.md#booking-and-payment-flow), the
  [payment lifecycle](../STATE_MACHINES.md#payment-lifecycle), and money rules in
  [`DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md#money).
