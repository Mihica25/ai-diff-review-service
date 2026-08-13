# Submission

## Cross-cutting verification

- **Migrations run automatically before the server starts.** An external code
  review tool flagged that Postgres migrations weren't wired into the app's
  start command — on a cloud platform with no SSH access, there's no way to
  manually run a migration script before first boot, so a fresh deploy would
  have come up against an empty database with no tables. I investigated this
  with Claude Code and we fixed it: migration logic moved into `src/db/migrate.ts`
  and is now invoked from `src/index.ts` on every boot (idempotent, tracked in
  a `schema_migrations` table, so repeat runs are no-ops). `scripts/migrate.ts`
  remains as a thin manual wrapper around the same logic for local use.
  I specifically tested a cold-boot scenario — wiped the database schema
  entirely, then ran only `npm start` with no manual steps beforehand — to
  confirm the tables get created automatically, so this couldn't silently
  break the first deploy on Render.
