# Current-main refresh evidence

This directory records the production-shaped #2352 correctness and security
refresh against current `main` after the stored-404 hotfix in PR #2583.

- Current commit: **RETARGET REQUIRED after PR #2591 merges.** Replace this
  placeholder with the exact final `origin/main` SHA before running the refresh;
  do not treat an earlier measurement SHA as current. The harness independently
  fails closed unless its worktree, `origin/main`, and app image SHAs agree.
- Baseline commit retained from the owner decision:
  `f442e389e0e5d4c2e18fa330b2fb155550b12871`
- Stack: isolated `tacbookings-measure` Compose project through Caddy on
  `127.0.0.1:8027`, PostgreSQL on `127.0.0.1:5435`, and no live providers.
- Image release id: `measure-fixed-release-2352`

Generated JSON and wire transcripts in this directory are raw test evidence.
The final assessment and threshold decision will be added after the repeated
baseline-versus-current timing runs and the bounded runtime-ISR spike.

## Adult-hosting public-content invalidation refresh

After PR #2591 is merged, the current image and isolated database have been
rebuilt from the same final `origin/main`, and the Playwright setup project has
created `e2e/.auth/e2e-admin.state.json`, run:

```bash
bash measurement/current-main-refresh/run-adult-hosting-invalidation.sh
```

The probe first fails closed unless the app, PostgreSQL and Caddy containers
have the exact measurement Compose service/network/loopback identities and the
app's own `DATABASE_URL` names the isolated `postgres` service. It takes an
atomic single-flight directory lock inside that verified Postgres container and
creates a unique per-run CMS page containing
`{{booking-policy-summary}}`, warms it to an ISR hit, changes the club-wide
adult-hosting consequence and host scope through the real admin API, and proves
that the next anonymous request is a regenerated miss with the new public
wording. Every tested response must retain `Cache-Control: private, no-store`
semantics and must not carry `public`, `s-maxage`, or
`stale-while-revalidate`.

The container lock serializes this harness against another copy of itself; it
does not exclude administrators, scripts, or any other database/API writer.
Run it only while the isolated measurement stack has no other writers. A page
create HTTP 409 is treated as a proven collision and is never recovered or
deleted as though the colliding row belonged to this run.

The exit trap compares the exact functional public-settings and adult-hosting
values with their pre-run snapshots and proves that the page's run-specific
ID, slug, and path are absent. This is not a bit-for-bit database rewind:
immutable audit rows remain, a restored existing hosting policy has a later
revision/version and write metadata, and a restored existing public-settings
row has later update metadata. Those residues and integer before/after audit
counts are recorded explicitly beside the functional comparison, and cleanup
fails unless the audit count increased. The probe writes
response bodies, response headers, API responses, a timeline, and a summary
under `adult-hosting-invalidation/<UTC run id>/`. Never copy the session cookie
or `measurement/stack/.env.measure` into that evidence.
