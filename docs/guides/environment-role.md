# Environment Safety

Audience: Operator, Adopter

## What it is

Every installation of this site is either **the club's live site** or **a copy of
it** — a staging site, a rehearsal after restoring last night's backup, or a
developer's laptop. This setting is where that is written down. Find it at
**Admin → Setup & Configuration → Environment Safety** (`/admin/environment`),
and on the first-install checklist as the **Production Or Non-Production** step.

It matters for one reason. A copy restored from the live database contains the
club's **real members and their real email addresses**. So anything that leaves
this application — a booking confirmation, a subscription reminder, an invoice
written into the club's Xero organisation — has to know which installation it is
running on before it goes out.

**The site never guesses.** The deployment says so explicitly, in one setting
(`APP_ENVIRONMENT_ROLE`, set outside the app in the deployment's environment),
and where nothing says, the answer is *not configured* rather than either one.
That is deliberate, and the "Why nothing is guessed" section below explains why
the obvious shortcuts are all wrong.

## When you'd use it

- **You are setting up a new installation**, live or otherwise, and the setup
  checklist is asking you to declare which it is.
- **You have restored a copy of the live database** onto a test site and want to
  be certain nothing from it can reach real members.
- **You are upgrading an existing live site** to this release or later, and need
  to add the declaration before the deploy will run.
- **Members have stopped receiving email** and you want to check whether this
  installation knows it is the live site.
- **Somebody asks who put this site into "copy" mode** and when.

## Step-by-step

### Read what this installation is

1. Go to **Admin → Setup & Configuration → Environment Safety**.
2. The panel at the top says one of three things:
   - **Production — the club's live site.** Emails go to real members and
     accounting goes to the club's real Xero organisation.
   - **Non-production — a copy.** Treated as a copy, whatever it holds.
   - **Not configured.** Nothing has said. See "What 'not configured' means"
     below — it is not the same as either of the other two.
3. Underneath, the page shows the two things that decide it: what the
   deployment's own configuration says, and whether the safer override is on.
   Where they disagree, it says which one won and why.

### Declare a live site

This is not done in the app, on purpose: a copy of the live database must not be
able to declare itself the live site.

1. On the server, open the deployment's `.env` file.
2. Add or correct the line:

   ```
   APP_ENVIRONMENT_ROLE=production
   ```

3. Deploy, or restart the app. `/admin/environment` and the setup checklist will
   then both report **Production**.

### Declare a copy

Same file, the other value:

```
APP_ENVIRONMENT_ROLE=non-production
```

The staging and end-to-end test stacks already declare this for you
(`docker-compose.staging.yml` sets it), so you only need to do this by hand for a
copy you have brought up yourself.

### Force a copy to stay safe, from inside the app

Use this when you have just restored a copy of the live database and want a
belt-and-braces guarantee while you work on it — particularly if you are not
certain what the deployment's own setting says.

> **It is stored in the database, so the next restore removes it.** This switch
> lives in the copy's own database — which is the file you replace every time you
> restore a fresh copy of the live data. After such a restore the row is gone,
> absent means off, and the copy goes back to whatever the deployment's own
> setting says. On a copy that inherited the live `.env` that means it resolves
> **Production** again, which is the very case this switch was protecting you
> from. So treat it as the immediate fix, and make it durable by setting
> `APP_ENVIRONMENT_ROLE=non-production` in the copy's own environment (above) —
> that lives outside the database and survives every restore.

1. Go to **Admin → Setup & Configuration → Environment Safety**. You must be a
   **Full Administrator**; other admins, including one holding every permission
   area at *edit*, see a short "available to full administrators only" panel.
2. Choose **Switch the override on**.
3. Read the consequences, tick the acknowledgement, then **Save**.

Nothing already recorded changes — no booking, payment, member or invoice is
touched. What changes is how this installation behaves from now on.

To undo it, choose **Switch the override off**. That is equally privileged and
equally audited, and it **does not** make an installation the live site: the
deployment's own setting decides again, so an undeclared installation goes back
to *not configured*.

## What "not configured" means

It means **nothing has said**, and the site refuses to pick for you.

It is **not** production. It is also **not** confirmed non-production — those are
different states with different consequences, and treating "we do not know" as
"this is a copy" would be its own guess. So anything whose safety depends on
knowing which installation this is is **held back** until you declare it. In
practice that means email to members and writes into the club's Xero
organisation.

If you meet this on a live site, the fix is one line in the deployment's `.env`
(above) and a restart. The setup checklist reports it as a **blocked** step with
that instruction, and the app logs an error at start-up naming the setting.

## Why nothing is guessed

Every cheap way of telling "am I the live site?" is wrong in a way that only
shows up on the day it matters:

| The tempting shortcut | Why it is wrong |
| --- | --- |
| `NODE_ENV=production` | A **build** mode, not a deployment identity. The staging stack runs a production build, so this says `production` there too. |
| `APP_RUNTIME_ROLE` | Names which container **slot** a process is (`web-blue`, `web-green`, `cron-leader`, `staging`). A deployment naming convention. **Setting it to `production` changes nothing here** — see the warning below. |
| The hostname or the site URL | DNS, and a copy can be given any name. |
| The database it is pointed at | A copy restored from the live database is byte-for-byte the live data. |
| Which branch was deployed | Says what the code is, not what the installation is. |

Each is a convention that holds right up until somebody stands up a copy that
breaks it — and that is precisely the copy that will email the club's members.

> **`APP_ENVIRONMENT_ROLE` is not `APP_RUNTIME_ROLE`.** They sit next to each
> other in the same Compose configuration and differ by one word, and on the
> staging stack `APP_RUNTIME_ROLE` literally holds the word `staging`. If you
> edit the wrong one, nothing you were trying to change will change. Both
> plausible mistakes are made to fail safely rather than silently:
> `APP_ENVIRONMENT_ROLE=staging` is **refused** (it is not one of the two
> accepted values) and leaves the site *not configured*, and
> `APP_RUNTIME_ROLE=production` changes no safety decision at all.

## Upgrading an existing live site

An installation set up before this release has no declaration, so on its own it
would come back as *not configured* and stop sending member email. Three things
stop that happening quietly.

**The production deploy refuses to run without it.**
`scripts/run-production-blue-green-deploy.sh` checks the `.env` entry at **step 3
of 20** — before the database migration (step 13), before the new release's first
process starts (step 14), and long before the traffic cutover (step 17). An
undeclared upgrade therefore **aborts with the previous release still serving and
nothing changed**. You add the line and run the deploy again.

**It refuses the opposite mistake too, and that one is easier to make.** That
script deploys the club's live site and nothing else — there is no staging mode in
it — so it also refuses a `.env` saying `APP_ENVIRONMENT_ROLE=non-production`.

The reason is worth understanding, because the mistake is a natural one.
`.env.example` ships `non-production`, which is correct for that file: it is a
local-development template, and one shipping `production` would have every
developer's laptop declaring itself the live site. But `.env.example` is also the
file you diff against your real `.env` when upgrading, and "a new key appeared in
the template, copy it across" is the normal move. If the deploy accepted it, the
upgrade would succeed, the new release would come up believing it was a copy, and
every real member's email would be held back — and once the Xero containment
lands, the email addresses on the club's **real** accounting contacts would be
rewritten to sandbox addresses. So the deploy stops, and says exactly that.

**The deploy also checks what each container actually received.** Validating the
`.env` file and validating what the containers were given are different
questions: Docker Compose prefers a value exported in the shell you ran the
deploy from over the file, and takes the last duplicate line rather than the
first. So at **step 14** — the new release started, the previous one still taking
every request — the deploy asks each app container which declaration it parsed
for itself, and stops before the cutover if any of them says anything other than
`production`. It also refuses a duplicated line and a shell value that disagrees
with the file, and says which is which.

**And the app says so loudly if an undeclared installation ever does come up** —
for example on a deployment brought up by hand with `docker compose up` rather
than through that script, which runs none of the checks above. Start-up logs an
error explaining the specific cause, and the setup checklist reports the
**Production Or Non-Production** step as blocked. An installation that comes up
as a *copy* says so at start-up too, and names which of the two sources decided
it, so an operator who did not expect it can tell whether to look at the `.env`
or at this page.

### After the deploy, read the message and not the tick

Open **Admin → Setup** and look at the **Production Or Non-Production** step. It
must say **production**.

This is worth spelling out because a *non-production* installation also shows a
green tick there — both are validly configured states, and the checklist cannot
know which one your installation is supposed to be. So the tick only tells you
that the question has been answered; the step's message is what tells you *which
answer*, and on the club's live site the only correct one is production.
`/admin/environment` says the same thing in more detail.

## Settings reference

| Setting | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| `APP_ENVIRONMENT_ROLE` | Whether this installation is the club's live site or a copy | **None — required** | Exactly `production` or `non-production` (case and surrounding spaces are ignored). Anything else is refused, not interpreted. Set in the deployment's environment, never in the app. Passed through `docker-compose.yml` with **no default** on purpose. |
| Safer override | Forces this installation to be treated as a copy, whatever the deployment says | Off | Full Administrator only, confirmed, and audited. Can only ever make the answer *safer*; there is no setting anywhere in the app that can declare an installation to be the live site. |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The page says **Not configured** | `APP_ENVIRONMENT_ROLE` is not set in this deployment's environment | Add `APP_ENVIRONMENT_ROLE=production` (live site) or `=non-production` (a copy) to the deployment's `.env` and restart |
| It says a value was **refused**, and quotes it | The setting holds something other than the two accepted words — commonly `prod`, `staging`, or a value copied from `APP_RUNTIME_ROLE` | Correct it to exactly `production` or `non-production` |
| I set `APP_RUNTIME_ROLE` and nothing changed | Wrong setting — that one names the container slot | Set `APP_ENVIRONMENT_ROLE` instead |
| Members stopped receiving email after an upgrade | The installation is *not configured*, so delivery is being held back | Declare the role as above; check the **Production Or Non-Production** step on `/admin/setup` |
| The deploy aborted at step 3 saying the entry must be exactly `production` | Working as designed — the declaration is missing, or it says `non-production` on the live site | Set `APP_ENVIRONMENT_ROLE=production` in `.env` on the server and run the deploy again. Nothing was migrated or switched |
| The deploy refused a `.env` I copied from `.env.example` | That template holds `non-production`, which is right for a laptop and wrong for the live site | Change the value to `production`. The template is not meant to be copied wholesale into a live deployment |
| The setup step shows a green tick but members still get no email | The tick means "declared", not "declared production" — read the message | If it says non-production, set `APP_ENVIRONMENT_ROLE=production` and restart |
| The page says the override **could not be read** | The database migration for this release has not been applied here | Run `prisma migrate deploy` (or `npm run db:migrate` in development) and reload |
| It says **Production** but this is a copy | The copy inherited the live `.env` | Set `APP_ENVIRONMENT_ROLE=non-production` on the copy, and switch the safer override on now if you need it safe immediately |
| It says **Not configured**, but the line is clearly there in `.env` | The line is indented, or begins with `export `. The value is read as a plain `KEY=value` line at the start of a line | Remove the leading spaces and the `export `, so the line begins with `APP_ENVIRONMENT_ROLE=` |
| It says a value was **refused**, and the value it quotes looks correct | The value is quoted in the file — `APP_ENVIRONMENT_ROLE="production"` — and the quotes are part of it | Write it without quotes: `APP_ENVIRONMENT_ROLE=production` |
| The deploy says the entry appears **twice** | `APP_ENVIRONMENT_ROLE` is set on two lines of `.env` | Delete all but one. This is refused rather than resolved because Docker Compose would use the last line and the deploy check reads the first, so the two could disagree about the most consequential setting in the file |
| The deploy says the value **disagrees between this shell and `.env`** | Something exported `APP_ENVIRONMENT_ROLE` into the shell you ran the deploy from — a wrapper script, a systemd unit, a restore rehearsal. Compose would use the shell's value, not the file's | Run `unset APP_ENVIRONMENT_ROLE`, remove it from whatever exported it, then run the deploy again |
| The deploy says a container reported the wrong **environmentRole** at step 14 | The container received a different value from the one `.env` holds, so the two checks above are worth re-reading | Nothing was switched — the previous release is still serving. Fix the shell or the file and run the deploy again |
| Who put this site into "copy" mode? | — | **Admin → Audit Log**, action `ENVIRONMENT_SAFETY_OVERRIDE_UPDATED`. The entry names the administrator and the value before and after |

## Related links

- Back to the [documentation hub](../README.md).
- Configuration reference: [`CONFIGURATION.md`](../../CONFIGURATION.md) →
  "Environment Role".
- The rule this implements: `INV-CONFIG-003` in
  [`product-configuration.md`](../invariants/product-configuration.md).
- Sibling setting recorded in the app rather than the environment:
  [Club Time Zone](club-time.md).
