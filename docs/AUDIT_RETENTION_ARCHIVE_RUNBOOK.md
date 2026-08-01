# Audit Retention And Archive Runbook

This runbook covers the production audit-log retention job and the optional archive database used by AlpineClubBookingsNZ.

## Runtime

- The audit retention job runs inside the existing `data-pruning` cron in `src/instrumentation.ts`.
- Schedule: daily at `03:30 Pacific/Auckland`.
- The job only runs on app instances with `CRON_ENABLED=true`; blue/green web slots should keep `CRON_ENABLED=false`.
- Cron run summaries are recorded under the `data-pruning` job name and include anonymized, archived, main-pruned, and archive-pruned counts.

## Retention Policy

- Raw request data (`ipAddress`, `userAgent`) is anonymized after 90 days unless `incidentPreserved=true`.
- `sensitive_access` and `standard` audit logs older than 12 months are copied to the archive database and then deleted from the main database when an archive database is configured.
- `critical` audit logs remain in the main database for 7 years before pruning, subject to `expiresAt`.
- `diagnostic_high_volume` audit logs are pruned from the main database when their `expiresAt` passes and are not moved to the archive database.
- Archive rows older than 7 years are pruned from the archive database.

## Archive Database Env Vars

Set one of these on the cron-enabled production app instance:

```bash
AUDIT_ARCHIVE_DATABASE_URL=postgresql://...
# Backward-compatible alias:
AUDIT_LOG_ARCHIVE_DATABASE_URL=postgresql://...
```

`AUDIT_ARCHIVE_DATABASE_URL` is preferred. If neither variable is set, the retention job logs `archive-db-not-configured`, still anonymizes request data, and still prunes expired main-database audit rows.

The archive database can be a separate PostgreSQL database. The job creates and maintains the `AuditLogArchive` table and supporting indexes automatically. Do not point the archive URL at the primary `DATABASE_URL`; archive movement deletes copied eligible rows from the main audit table.

## Archive Table Columns

`AuditLogArchive` mirrors **every** column of the `AuditLog` model. The archive copy is the only surviving record — archive movement deletes the source row — so a column left out of the archive would be lost permanently.

Coverage is no longer a hand-kept list. `src/lib/audit-retention.ts` holds one manifest, `AUDIT_ARCHIVE_COLUMNS`, and generates all three archive surfaces from it: the Prisma `select` that reads eligible rows, the `CREATE TABLE` that provisions the archive, and the `INSERT` that writes each row. The manifest's key type comes from the `AuditLog` model itself, so the coverage is exhaustive by construction (#2290).

Two columns are stored differently from the main table, by design:

- `archivedAt` records when the copy was written and is `NOT NULL` in the archive, even though it is nullable in the main table.
- `ipAddress` and `userAgent` are written as `NULL` unless the row is `incidentPreserved`, matching the 90-day request-data policy above.

### Adding a column to AuditLog

1. **Nothing to remember in the app.** Adding a column to the `AuditLog` model fails the TypeScript build in `src/lib/audit-retention.ts` until the column is added to `AUDIT_ARCHIVE_COLUMNS` (one line: its archive column type) or listed in `AUDIT_ARCHIVE_EXCLUDED_COLUMNS` with a written reason for dropping it on archival. `src/lib/__tests__/audit-archive-columns.test.ts` checks the same contract in CI.

2. **An existing archive database needs a migration.** The job provisions the archive table with `CREATE TABLE IF NOT EXISTS`, so an archive database created before the new column will not gain it automatically. Add it once, on the archive database, before the next `data-pruning` run:

   ```sql
   ALTER TABLE "AuditLogArchive" ADD COLUMN IF NOT EXISTS "newColumn" TEXT;
   ```

   Use the same column type the manifest declares for it.

3. **If step 2 is missed, the job fails loudly rather than losing data.** The `INSERT` names the new column, PostgreSQL rejects it, and the archive step raises before any row is deleted from the main table. Nothing is archived and nothing is lost until the archive table is corrected.

To check an existing archive database against the current model, compare the two column lists:

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'AuditLogArchive'
ORDER BY column_name;
```

Rows archived before a column existed keep `NULL` for it; the archive is not backfilled.

## Operator Checks

1. Confirm the cron-enabled app has exactly one archive URL set when archive movement is required.
2. Confirm the archive DB is included in infrastructure backups before enabling the URL.
3. After the next `data-pruning` run, check the cron summary for `archiveSkipped=false` and non-error completion.
4. If archive movement must be paused, remove the archive URL and restart only the cron-enabled app instance.
5. After a release that adds a column to `AuditLog`, apply the `ALTER TABLE` in "Adding a column to AuditLog" to the archive database before the next `data-pruning` run.
