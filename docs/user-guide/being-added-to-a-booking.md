# Being added to a booking by another member

Audience: Member

## What it is

Another club member — someone outside your own family group — can put you on
their booking as a **member guest**, when the club has switched that feature on.
By default nothing is settled until you agree: you get an email, a bed is held
for you, and you say **Yes, add me** or **No thanks** on the booking's own page
(`/bookings/<id>`, at the **consent** card near the top). If the member being
added has no login of their own — a child, or an adult on a household login —
the adults in their family group are asked instead, on a dedicated page
(`/bookings/consent/<id>`).

Some clubs choose to **tell** rather than ask. In that case your place is held
straight away, the email says so, and you can still take yourself off the
booking if you would rather not go.

## When you'd use it

- You got an email saying another member would like to add you to a lodge
  booking, and you need to answer it.
- You got an email about your child (or another family member without a login)
  being added, and you are being asked on their behalf.
- You were told you have been added (a "tell, don't ask" club, or the club
  office added you) and you want to know what you can do about it.

## Step-by-step

### Answering for yourself

1. Open **Answer this request** in the email. It takes you to the booking's own
   page — as soon as someone asks to add you, you can see the whole booking,
   including everyone on it.
2. Read the consent card at the top: who made the booking, the lodge, the stay,
   **your nights**, the date to answer by, and everyone on the booking.
3. Choose **Yes, add me** or **No thanks**.
   - **Yes** confirms your place. The person who made the booking is emailed.
   - **No** releases the bed that was held for you and takes you off the
     booking. They are emailed about that too.
4. If you do nothing, the request **lapses on its own** at the answer-by date.
   The bed is released and the person who made the booking is told. You never
   have to do anything to decline.
   - The answer-by date is normally pulled back so that it falls no later than
     the day before check-in, which is what stops a lapsed request tying up a
     bed on the night itself. There is one exception: every request is given at
     least two hours to be answered, and on a booking made in the last hours
     before check-in those two hours win. An answer-by date on the check-in day
     itself means the booking was made that late — not that something has gone
     wrong.
   - Releasing the bed is not always possible. If you are the only guest on the
     booking, the club priced it by hand, the booking's state no longer allows
     changes, or check-in has already started, the lapse cannot take you off.
     The request is recorded as lapsed either way, and it goes on a list the
     club office works through by hand instead of quietly holding the bed.

Sometimes saying no cannot be actioned from your side — for example you are the
only guest on the booking (removing you would leave it empty), or the club
priced the booking by hand as a quote. When that is already known, the card
says so before you click and tells you who *can* act — usually the person who
made the booking, or the club. One case is only knowable when you try: a
booking that has already been paid may need the owner or the club to choose
between a refund and account credit, and if the club's system refuses your
"No thanks" for that reason, the card shows you the exact explanation.

### Answering for a family member

1. If the member being added cannot log in themselves, the request email goes to
   the adults in their family group. Its link opens a consent page showing just
   the request: who is asking, the lodge, the stay, the member's nights, the
   answer-by date, and everyone on the booking — by name only.
2. Choose **Yes, add [name]** or **No thanks**. Your answer counts as theirs,
   and your name is recorded against it.
3. You will not see the booking itself — that page belongs to the people on the
   booking. If the request has already been answered, has lapsed, or is not
   yours to answer, the page says so plainly.

### If you were told, not asked

Your club may add member guests without asking first. The email (and a notice
on the booking page) says your place is already held. If you would rather not
go, use **Remove me from this booking** on the booking's page — the same
self-removal every guest has.

## What to expect

- **No money is in the email.** The request email and the consent page name the
  people and the dates, never prices. (Once you can open the booking page
  itself, you see the same booking details every guest on it sees.)
- **You will always be asked, if asking is on.** The consent email is not a
  newsletter: it is sent even if you have muted notification categories in your
  preferences.
- **Everyone on the booking can see the state of your answer** — a badge on the
  guest list shows *Waiting for consent*, *Consented*, or that the request
  lapsed. Family guests and non-member guests have no such badge; nothing
  changes for them.
- **A held bed is only a held bed.** Until you say yes you are not on the chore
  roster, the arrivals list, or a bed plan, and no arrival email names you.

## Troubleshooting

| Symptom | Why | What to do |
| --- | --- | --- |
| The email link says there is nothing to answer | The request was already answered (perhaps by another family adult), it lapsed, or you are signed in to a different account than the email was sent to | Check you are signed in as the person the email was addressed to; ask the person who made the booking to add you again if it lapsed |
| The card offers only **Yes** | Saying no cannot be actioned from your side (you are the only guest, or the booking is quote-priced) | The card names who can act — ask the person who made the booking, or the club |
| You said no but were told it could not be done | The booking has already been paid and the reduction needs a refund-or-credit decision by the owner or the club | Ask the person who made the booking, or the club office, to take you off |
| You never answered and the request disappeared | It lapsed at the answer-by date; the bed was released | If you did want to come, ask the person who made the booking to add you again |

## Related links

- Back to the [member guide index](README.md) and the
  [documentation hub](../README.md).
- Sibling guides: [Booking a stay](booking-a-stay.md),
  [Changing or cancelling a booking](changing-or-cancelling-a-booking.md),
  [Managing your family & household](managing-your-family.md).
- The full lifecycle (states, expiry, what admins see) is specified in
  [`STATE_MACHINES.md`](../STATE_MACHINES.md) and
  [`UX_FLOW_MAP.md`](../UX_FLOW_MAP.md).
