# Integrations

Audience: Operator

## What it is

The hub for connected external services used by accounting and other
provider-backed workflows. It holds a card per integration — **Xero Setup**,
**Stripe Setup**, **Google sign-in Setup**, **Google Analytics**, and **Database
Backups**. Most cards open that provider's own setup page; **Google Analytics**
opens its settings in place, on the hub. Find it at **Admin → Setup &
Configuration → Integrations** (`/admin/integrations`).

> **The hub itself is not feature-gated (#2216).** `/admin/integrations` is
> deliberately *not* listed under any module flag in
> `src/config/feature-routes.ts`, so the hub renders whenever any integration
> module is on. Each card is feature- and permission-filtered individually by
> `AdminHubPage`, and every destination keeps its own gate — so the hub simply
> shows whichever integrations are enabled for the current admin. In particular
> the **Xero Setup** card (and the `/admin/xero/*` routes behind it) stays gated
> by the `xeroIntegration` module: with Xero off the card is absent but the hub —
> and the other cards / their back-links to it — remain reachable. The
> demo/staging seed leaves Xero **off** (the `xeroIntegration` module defaults
> off), so the documentation screenshot harness captures the hub without its Xero
> card; this guide describes the Xero flow in prose. Enable the Xero integration
> module to reach the live Xero Setup page.

## When you'd use it

- You're connecting the club's Xero organisation for the first time.
- You need to re-authorise or reconfigure the Xero connection or its accounting
  mappings.
- You're setting up Google Analytics, or changing whether visitors are asked
  before it runs.
- You're checking which provider integrations are available to enable.

## Step-by-step

### Open Xero setup

1. Enable the **Xero integration** module on [Modules](modules.md) (the Xero
   Setup card and the `/admin/xero/*` routes stay hidden until it is on; the
   Integrations hub itself remains reachable regardless).
2. Go to **Admin → Setup & Configuration → Integrations**. With Xero enabled the
   hub shows the **Xero Setup** card.
3. Open **Xero Setup** (`/admin/xero/setup`) to connect Xero and configure the
   accounting settings finance workflows rely on. The connection, sync,
   reconciliation ledger, and records browser are documented in the
   [Xero Sync](xero.md) guide and [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md).

### Set up Google Analytics

**This is a required step after upgrading to the release that carries #2573.** The
GA4 measurement id used to be a deployment environment variable
(`NEXT_PUBLIC_GA_MEASUREMENT_ID`). It is now club configuration held in the
database, nothing reads the environment variable any more, and its old value is
**not** copied across. So analytics stops at that deploy and stays off until an
admin completes the steps below. No restart or redeploy is needed.

1. Enable the **Google Analytics** module on [Modules](modules.md). With the
   module off there is no card, no configuration API, and no tag on the website.
2. Go to **Admin → Setup & Configuration → Integrations** and open **Set up
   Google Analytics** on the Google Analytics card.
3. Select **Edit**, then paste your **GA4 measurement id**. It looks like
   `G-ABCDE12345` and is in Google Analytics under **Admin → Data streams → your
   web stream**. A Google Tag Manager container id (`GTM-…`) or a Universal
   Analytics property id (`UA-…`) will not work.
4. Choose the **visitor consent banner** mode:
   - **Show the consent banner (recommended).** Nothing at all is sent to Google
     — no tag, no request, no cookieless ping, no consent signal — until a
     visitor selects **Accept**. Declining or dismissing the banner leaves
     analytics off.
   - **Do not show the consent banner.** Analytics loads automatically on
     eligible public pages without asking first. Visitors who previously declined
     start being measured again, and can only opt out afterwards. The setup screen
     warns you about this before you save it.
5. Edit the **banner message** if you want different wording. It is plain text;
   HTML and Markdown are shown literally. The **Accept** and **Decline** button
   labels are set by the application.
6. Select **Save**. The status chip on the card then reads **Configured with
   consent banner** or **Configured without consent banner**.
7. In Google Analytics, open **Admin → Data streams → your web stream → Enhanced
   measurement** and switch **Page changes based on browser history events** off.
   This application sends one page view per address itself, with the address
   stripped of anything after a `?` or a `#`. Left on, Google adds a page view of
   its own each time a visitor moves between pages, so views are counted twice.
   The option is Google's and is on by default for a new stream; nothing in this
   application can change it.

Two things the application deliberately does not do: it never claims a consent
mode is legally compliant, and it does not decide your privacy disclosures for
you. Whichever mode you pick, your privacy policy should say that the club uses
Google Analytics — the setup screen warns you if no privacy policy page is
published, and links you to [Website pages](page-content.md). Publishing that page
also matters to the visitor: while it is published, the consent banner and the
public **Analytics preferences** panel link it, so somebody deciding whether to
allow analytics can read the policy first. While it is not, they show no link
rather than one to a missing page.

**Ask visitors to choose again** is a separate action on the same screen, offered
only while the banner is on. It clears every visitor's stored banner choice so
they are asked again, and it is audit logged. Ordinary wording edits never do
this, so fixing a typo does not reset anybody's choice.

Where analytics runs is fixed by the application and cannot be configured: the
public website only. It never runs on admin pages, on signed-in member pages, or
on any address carrying a token, PIN or personal identifier, and the addresses it
reports carry no query strings or fragments.

## Settings reference

| Card | What it opens | Requires |
| --- | --- | --- |
| Xero Setup | The Xero connection and accounting configuration (`/admin/xero/setup`) | The `xeroIntegration` module; Xero OAuth credentials and tenant tokens configured server-side |
| Google Analytics | Its settings in place on the hub: GA4 measurement id, consent-banner mode, banner wording, and **Ask visitors to choose again** | The `analytics` module; finance **view** to see the status, finance **edit** to change anything |
| Database Backups | The guided backup setup wizard (`/admin/backups/setup`): S3 credentials, destination, nightly schedule, and a verification run | Support view; the S3 credentials and destination writes require Full Admin. See [Database Backups](backups.md) |

Integrations is a **support**/**finance** area hub; the Xero credentials
themselves are configured outside this table (see [`CONFIGURATION.md`](../../CONFIGURATION.md)
and [`DEPLOYMENT.md`](../../DEPLOYMENT.md)).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No **Xero Setup** card on the Integrations hub | The `xeroIntegration` module is off (the hub still renders; only its Xero card is hidden) | Enable it on [Modules](modules.md) |
| `/admin/integrations` shows a 404 | No integration surfaces are reachable at all, or the admin layout gate blocks you | Confirm you have an integration/finance/support area role; the hub itself is not module-gated (#2216) |
| Xero Setup won't connect | Xero OAuth credentials/tenant tokens aren't configured server-side | Configure them per [`CONFIGURATION.md`](../../CONFIGURATION.md); see [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md) |
| Analytics stopped working after an upgrade | Expected: `NEXT_PUBLIC_GA_MEASUREMENT_ID` no longer works and its value was not copied over (#2573) | Re-enter the measurement id on the Google Analytics card, then remove the environment variable |
| No **Google Analytics** card on the hub | The `analytics` module is off | Enable it on [Modules](modules.md) |
| The card reads **Invalid or incomplete configuration** | The stored measurement id is not a GA4 id — usually a restored database or a hand-edited row | Open the card, select Edit, and re-enter an id in the form `G-ABCDE12345` |
| The card reads **Setup required** and no tag appears | No measurement id is saved. Analytics fails closed: no id, an invalid id, or a database read failure all mean no analytics | Enter and save the measurement id |
| Analytics reports no page views for one page | Its address is not analytics-eligible — an unhyphenated identifier-shaped slug, or a word the policy treats as credential-flavoured | Rename the page to a hyphenated word slug; the exclusion is deliberate and not configurable |
| The **Analytics preferences** link is missing from the website footer | The module is off, or no valid measurement id is saved | Complete the setup; the link appears in both banner modes once configured |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Modules](modules.md), [Setup](setup.md),
  [Xero Sync](xero.md), [Internet Banking](internet-banking.md).
- Reference: [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md),
  [`CONFIGURATION.md`](../../CONFIGURATION.md), and [`DEPLOYMENT.md`](../../DEPLOYMENT.md).
