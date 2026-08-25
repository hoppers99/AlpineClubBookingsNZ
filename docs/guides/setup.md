# Setup

Audience: Operator

## What it is

The installation and configuration hub: a **readiness checklist** that grades
your club's setup (with live provider tests for Stripe, SMTP, Sentry, and Xero)
plus a grid of **hub cards** that jump into each configuration area — initial
setup, finance, booking rules, integrations, membership, cancellation, and
notifications. Find it at **Admin → Setup & Configuration → Setup**
(`/admin/setup`).

The page's own route is the **support** area, but it embeds cross-area cards
whose backing pages enforce their own permission areas — so which cards you can
open depends on your role. It is the natural starting point after a fresh
install and the map to everything else in Setup & Configuration.

## When you'd use it

- You've just stood up a fork and want a guided checklist of what still needs
  configuring.
- You want to test that Stripe, email (SMTP), Sentry, or Xero are actually
  reachable from this environment.
- You need to find the right configuration sub-area and don't want to hunt the
  sidebar.

## Step-by-step

### Which setup surface to use, and when

There are two ways into the same work, and one page that looks like a third but
is not.

| Surface | Use it when | Where |
| --- | --- | --- |
| **The setup wizard** | You are setting a club up, coming back to finish, or have just upgraded and want to be told what is new | `/admin/setup/wizard` |
| **The readiness checklist and hub cards** | You already know what you are looking for and want to go straight to it, or you want to run a provider test | `/admin/setup` |
| **Alpine Central Server setup** | *Not a setup surface at all* — see below | `/admin/alpine-server/setup` |

The wizard is the destination: it is where a club's setup is meant to be done,
and the checklist is the map you keep for later. Neither can tell you something
the other would contradict. **Both derive the list of steps from the same
place**, so the number of outstanding items, and which items they are, are the
same answer shown two ways — the wizard as a percentage down its rail, the
checklist as cards grouped by category.

That shared derivation has one consequence worth knowing: **switching a module
off removes its setup steps from both surfaces.** Turn Xero off in
[Modules](modules.md) and the Operational Xero and Xero Mappings steps stop
appearing, the Finance hub card goes with them, and the progress percentage
recalculates around what is left. Nothing is deleted and nothing is
remembered — the module toggle is the only record that the club said no, so
turning it back on brings the steps straight back with whatever progress had
already been recorded against them. This is also why progress reads as a
percentage rather than "x of y": the total moves as modules do.

**Alpine Central Server setup is not a competitor to either.** Despite living at
a `/setup` path, `/admin/alpine-server/setup` is a **provider-connection page** —
the sibling of Xero Setup and Stripe's credential capture, not of this checklist.
It reads none of the setup-progress machinery, contributes no readiness check
and no wizard step, and finishing it does not move your setup percentage. If you
are looking for the club's setup progress, it is not there. See
[Integrations](integrations.md) for what that page does.

### Work the checklist and jump to a sub-area

Each hub card opens an aggregator surface that regroups settings owned and
documented in their own areas' guides, so this hub's single screenshot is
enough — every sub-page is captured and detailed where it lives.

1. Go to **Admin → Setup & Configuration → Setup**. The readiness summary shows
   how many checks are complete, warning, or blocked.

   ![Setup hub showing the readiness checklist summary, provider test actions, and the grid of configuration hub cards](../images/admin/admin-setup.png)

2. Work through the **checklist categories**. A check can be marked done or
   skipped, and provider checks offer a **test** button (Stripe, SMTP, Sentry,
   Xero) that pings the live service and reports the result. Marking a check
   done, skipping it, reopening it, finishing setup and resetting progress are
   each recorded in the [Audit Log](audit-log.md) under their own event type
   and in the **system** category, so you can see who changed what and when.
3. Use the **hub cards** to open a configuration area: Initial Setup, Finance,
   Booking Rules, Operational Integrations, Membership & Members, Cancellation,
   or Email Messages / Notifications.

### Or walk the guided journey instead

The checklist tells you what is outstanding. The **setup wizard** walks you
through it, one step at a time, and remembers where you got to — so it can be
left and picked up again, and a club that set up a year ago and then upgraded is
told what is new rather than left to find it.

Both surfaces are live and derive the same step list, so nothing is lost either
way — see [Which setup surface to use, and when](#which-setup-surface-to-use-and-when)
above for how to choose.

1. On **Admin → Setup & Configuration → Setup**, choose **Open the setup
   wizard** — or go straight to `/admin/setup/wizard`. It opens at the step you
   left off at, not back at the beginning.
2. The **rail** down the left carries the whole journey, grouped under the same
   headings as the checklist. Each row says where that step stands:

   | The row says | It means |
   | --- | --- |
   | Done | The step's check passes, or you marked it done |
   | Up next | Where the wizard will resume you |
   | Needs another look | You finished it, but something it depends on has changed since |
   | Skipped for now | You chose to pass over it. It stays on the list as outstanding |
   | Not started | Nothing has happened here yet |

   Progress reads as a **percentage** rather than "x of y" on purpose: the
   number of steps changes as you switch modules on and off, and a count would
   look as though work had been lost. It stays visible while the rail scrolls.
3. The right-hand pane shows the step's live check — what is outstanding, in the
   same words the checklist uses — with a link through to the settings page
   where that work is actually done. The wizard never becomes a second place to
   store a setting. **Website Styling** is a step of exactly this shape: it
   links to [Site Style](site-style.md) rather than embedding a second colour
   picker, and it reports done the moment any colour, font, logo or Raw CSS
   differs from the shipped defaults — whether that was saved from Site Style
   directly or by following this step's link. Finishing this step never makes
   the public site visible; that only happens from **Ready to open** below, or
   from Site Style's own Finish-setup control.

   **Lodges** is the other step of that shape, and the one that reports on more
   than one thing at once. It does not embed a lodge editor: it lists every
   lodge the club has with its own state — open for booking, or still to be
   activated — with its active room and bed counts, and a link straight into
   that lodge's own guided setup. It reads done when every lodge is open for
   booking, and warns while any one of them is still closed. Room and bed
   counts are shown but never decide the verdict: a lodge can legitimately run
   on a capacity override with no beds recorded. **A lodge's own completeness
   is reported separately from the club's** — however many lodges you have,
   this is one step of the journey, so adding a second lodge does not make the
   percentage go backwards.
4. **Mark this step done**, **Skip for now**, or **Reopen** it, then
   **Continue**. Skipping buys you passage past a step; it does not hide it. A
   skipped step stays on the rail and on the outstanding list until it is done
   or no longer applies. You cannot skip *ahead* of a step you have not settled
   one way or the other — those rows are greyed and will not open.
5. Switching a module off removes its steps entirely (a module you have declined
   has nothing to configure). Change one on the **Modules** page and the rail
   redraws when you come back to the wizard's tab.
6. Once every step is done or skipped, **Ready to open** unlocks at the foot of
   the rail. It carries two separate things:
   - **Make the public site visible** — until you do this, visitors see the
     holding screen rather than the club's pages. This is the only place in the
     wizard that publishes the site.
   - **Confirm what this instance is for** — names the role (production,
     non-production, or not configured), says which source decided it (the
     deployment's own `APP_ENVIRONMENT_ROLE`, or an administrator's safer
     override), and states plainly what a non-production installation
     withholds: no email to members, and every Xero contact it touches has its
     address replaced so Xero cannot reach a member from here either. Nothing
     here is switched on from a screen — that is declared in the environment
     (`.env`) and never from the wizard, so a copy of the live database can
     never declare itself the live site — but the panel does say how much
     application email is currently being held back for environment-safety
     reasons and links through to **Admin → Environment** for the full
     picture. If nothing has declared the role yet, a banner explains what is
     paused (member email and Xero writes, both) and exactly what to set. This
     lever does not gate the one above: an internal test site that is
     deliberately visible and deliberately not production is a perfectly
     normal, permanent state.

   Anything you skipped is listed on that panel in plain words rather than
   quietly dropped.

#### When a finished step needs another look

Some steps only make sense once an earlier one is settled. If you go back and
reopen one of those earlier steps, anything that depended on it — and anything
that depended on *that* — moves to **Needs another look**.

Four things are worth knowing about that state, because it is the one people
find surprising:

- **It is remembered.** The wizard writes down which steps went back into
  question, so closing the tab, coming back tomorrow, or another officer opening
  the wizard all show the same picture rather than a fresh guess each time.
- **Nothing you did is thrown away.** A step that needs another look is still
  recorded as done. The wizard is asking you to confirm it still reads correctly
  now the thing underneath it has changed — not telling you to do it again. When
  the step it depends on is settled, it goes quietly back to **Done** without
  your having to open it at all.
- **It counts as outstanding while it lasts**, so it holds the percentage back
  and keeps **Ready to open** locked. That is the point: a club is not finished
  setting up while something is waiting to be checked.
- **"Setup complete" is withdrawn while anything needs another look.** If you
  had already finished setup, the wizard stops showing **Setup complete** while
  steps need another look, and once they are settled an administrator finishes
  setup again from the checklist. A club should never be told it has finished
  over work that is still open — and the club, not the software, decides when it
  is finished, so the flag is never quietly put back.

Each change is recorded in the [Audit Log](audit-log.md) under its own event
type — one for steps that started needing another look, one for steps that
stopped — so you can see when it happened and which step caused it. If you press
**Finish setup** while something still needs another look, that is recorded too,
along with which steps held it back, so the trail explains why the club is not
showing as finished.

**If the wizard cannot work the list out, it changes nothing.** Deciding which
steps need another look means reading the rest of the installation's settings,
and if that read fails — a database hiccup, say — the wizard refuses the change
and says so rather than saving it with the list guessed at. Nothing is recorded
and nothing is logged, so pressing the button again once the problem clears does
exactly what you asked the first time.

**One thing the wizard does not notice on its own.** The list of steps needing
another look is worked out when you mark a step done, defer it, reopen it, or
finish or reset the checklist — not continuously. So if a setting a completed
step depends on is changed on its own settings page rather than through the
wizard, the steps *downstream* of it are not moved to **Needs another look**
until the next time somebody makes one of those wizard changes. The step whose
own check the setting broke does show it straight away, because that is read
live. In practice this cannot arise yet — no step depends on another today — and
it is revisited when modules start contributing their own steps.

Upgrading the platform does **not** put finished steps back into question. A
step that a new release *adds* arrives as **Not started**, which is a different
thing: nobody has done it yet, rather than somebody having done it and something
having changed underneath it.

**What you can change depends on your role, and there are two different
answers.** The wizard is reachable by anyone who can reach the Setup page, and
everyone can read and walk the whole journey.

- **Marking a step done, skipping it, or reopening it** needs **Support** edit
  access. That is one answer for the whole journey rather than one per step,
  because all three are the same underlying action — the same one the readiness
  checklist's own buttons perform. Without it those three buttons are disabled,
  and one banner at the top of the step says so.
- **Doing the step's actual work** happens on the settings page the step links
  to, and needs edit access to **that page's** area — which the wizard names
  underneath the link. So a Support officer can record that a step is done but
  may still need a Bookings or Finance officer to make the change itself; and an
  officer who can make the change may need someone with Support access to tick
  it off.

Two of those settings pages ask for more than their area implies: **Club Time
Zone** is full-administrator only whatever your Support level, and **Runtime
Environment** is edited in the deployment's `.env` file rather than on any
screen.

## Settings reference

The Setup page itself only tracks checklist progress; the real settings live in
the areas it links to:

| Hub card | Opens | Its permission area |
| --- | --- | --- |
| Initial Setup | Install checklist, club identity, modules, lodge records, health (`/admin/setup/foundations`) | support |
| Finance | Finance reporting, Xero setup, sync tools, report mappings — collapsed by default (`/admin/setup/finance`) | finance |
| Booking Rules | Booking policy, seasons, age groups, promos, inventory, copy (`/admin/setup/booking-rules`) | bookings, lodge |
| Operational Integrations | Provider readiness, Xero connection, modules, delivery health (`/admin/setup/integrations`) | support, finance |
| Membership & Members | Membership types, member fields, subscription lockout ([membership-setup](membership-setup.md)) | membership |
| Cancellation | Cancellation settings, request queues, message copy (`/admin/setup/cancellation`) | membership, support |
| Email Messages / Notifications | Delivery rules, recipients, templates, member copy ([notifications](notifications.md)) | support |

A hub card appears only while there is still something behind it: your role can
open it, its area's module is on, **and** at least one of the checklist steps it
covers still applies to this club. Membership & Members and Email Messages /
Notifications cover no checklist step at all — they are ongoing club
configuration rather than first-install readiness — so those two are governed by
permissions and modules only, and never disappear because of a module toggle.

Provider tests cover Stripe, SMTP (email), Sentry, and Xero. Each check is
**complete**, **warning**, **blocked**, or **not started**.

Three checklist steps do not sit behind a hub card. Two are a single setting
rather than a settings area: **Club Time Zone** links straight to
[`/admin/club-time`](club-time.md), and **Website Styling** links straight to
[`/admin/site-style`](site-style.md). The third, **Lodges**, links to
[`/admin/lodges`](lodges.md) and additionally offers one link per lodge into
that lodge's own guided setup, because a club's lodges are a list rather than a
setting.

Club Time Zone: on a fresh install it reads **blocked** until a time zone is
recorded, so setup cannot be finished without one. After an upgrade it usually
reads *complete* and names the zone — the application records the zone it was
already effectively using the first time it starts, so nothing needs choosing.

Two other answers are worth recognising. A **warning** means the zone could not be
confirmed: the server's `TZ` named no actual place (`UTC`, `Etc/UTC`), so
`Pacific/Auckland` was recorded and the checklist is asking you to confirm it —
act on this one if the club is not in New Zealand. Still **blocked** after an
upgrade means the application has not restarted since the migration; restart it,
or run `npm run config:self-heal`.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A provider test fails | The credentials/config for that provider are missing or wrong | Fix them per [`CONFIGURATION.md`](../../CONFIGURATION.md); re-run the test |
| A hub card is missing or greyed | Your role lacks the card's permission area | Ask a full admin, or an admin with that area, to complete it |
| The **Finance** hub card has disappeared | Every step behind it belongs to a module that is switched off — with both Xero and the finance dashboard off there is no finance setup left to do, so the card goes rather than opening a page with nothing in it | Switch the module back on in [Modules](modules.md); the card and its steps return together |
| A readiness card you remember is no longer listed | Its module was switched off. A module contributes no steps while it is off, on either surface | Check [Modules](modules.md). Nothing was lost — turning it back on restores the step and any progress recorded against it |
| A check stays "blocked" | A required dependency isn't in place | Open the linked area and resolve the named requirement |
| **Club Time Zone** stays blocked right after an upgrade | The application has not restarted since the migration, so the zone has not been recorded yet. The zone in use is still the right one | Restart the application, or run `npm run config:self-heal`. See the [Club Time Zone guide](club-time.md) |
| **Club Time Zone** shows a warning about confirming the zone | The server's `TZ` named no actual place, so `Pacific/Auckland` was recorded rather than guessed at from a value that names no location | If the club is in New Zealand, acknowledge the step. If not, set the real zone at [`/admin/club-time`](club-time.md) — this is the case that would otherwise put a non-NZ club's times out by hours |
| Setup shows incomplete after go-live | Optional checks were left unskipped | Mark genuinely-skipped checks as skipped so the summary reflects reality |
| A wizard step will not open | It is further ahead than you have reached | Settle the steps before it — finish them, or skip the ones that do not apply |
| **Ready to open** stays locked in the wizard | Something is still outstanding and has not been skipped | Work down the rail; anything you genuinely do not need can be skipped, which counts as settled |
| A wizard step's Done / Skip / Reopen buttons are all disabled | Your role has view-only access to **Support**, which is what recording progress needs — on every step, not just this one | Ask an admin with Support edit access to record it. Note this is separate from being able to make the change itself, which needs the settings page's own area |
| The rail still shows a module's steps after switching it off | The wizard has not re-read the journey yet | Return to the wizard's tab, or press **Refresh** |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Modules](modules.md), [Integrations](integrations.md),
  [Login & Security](security.md), [Membership & Members setup](membership-setup.md),
  [Notifications & Email](notifications.md), [Club Time Zone](club-time.md).
- Reference: [`CONFIGURATION.md`](../../CONFIGURATION.md) and the
  [`IMPLEMENTATION_GUIDE.md`](../IMPLEMENTATION_GUIDE.md).
