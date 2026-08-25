# Prisma setup notes (Phase 1)

## Why this differs from the original plan's schema snippet

The approved plan's `schema.prisma` draft was written against an older Prisma
version's conventions. This project has **Prisma 7.9.1** installed, which has
a breaking change relevant to this schema: **`datasource { url = ... }` and
`directUrl = ...` are no longer valid inside `schema.prisma`.**
`npx prisma validate` fails immediately with `P1012` if you put them back.

What changed, concretely:

- **Where connection strings live now:** `prisma.config.ts` (project root),
  not `schema.prisma`. This file is read by the **Prisma CLI only**
  (`validate`, `generate`, `migrate`, `db seed`, `studio`) — the running app
  never reads it.
- **`prisma.config.ts`'s `datasource.url`** is set to `process.env.DIRECT_URL`
  — the non-pooled Neon connection — because `prisma migrate` runs DDL and
  DDL should not go through a pgBouncer-style pooler.
- **The Prisma Client at runtime** no longer accepts an implicit
  schema-embedded URL either. `PrismaClient` now requires an explicit
  **driver adapter**. `src/lib/server/db.ts` constructs one from the
  **pooled** `DATABASE_URL`:
  ```ts
  import { PrismaPg } from "@prisma/adapter-pg";
  const adapter = new PrismaPg(process.env.DATABASE_URL);
  new PrismaClient({ adapter });
  ```
  This required adding `@prisma/adapter-pg` and `pg` as dependencies.
- There is no more schema-level `directUrl` field at all (not just moved —
  removed). The plan's `directUrl = env("DIRECT_URL")` line does not exist in
  the current `schema.prisma`; `DIRECT_URL` is consumed exclusively by
  `prisma.config.ts` for CLI/migration commands.
- **Seed command location moved too.** Prisma 7's `migrations.seed` config in
  `prisma.config.ts` replaces the old `package.json` → `"prisma": { "seed":
  ... }` key (which is no longer read). `package.json` keeps a `db:seed`
  script (`tsx prisma/seed.ts`) as a convenience for running the same script
  directly, but the wiring `prisma db seed` uses comes from
  `prisma.config.ts`.

None of this changes the data model itself — every model/enum/field/relation/
index from the approved plan is implemented as specified.

## The `Budget` owner XOR constraint

`Budget.userId` and `Budget.familyId` are both nullable so a budget can belong
to either an individual or a family, but exactly one of the two must be set —
Prisma's schema language cannot express that as a declarative constraint, so
it isn't in `schema.prisma`. It must be added as a raw `CHECK` constraint once
the first migration is generated against a real database connection:

```sql
ALTER TABLE "Budget" ADD CONSTRAINT budget_owner_xor
  CHECK ((user_id IS NOT NULL)::int + (family_id IS NOT NULL)::int = 1);
```

How to apply it: after running `npx prisma migrate dev --name init` (which
will fail today — see below — until a real `DATABASE_URL`/`DIRECT_URL` are
set), Prisma generates a numbered folder under `prisma/migrations/` containing
a `migration.sql` file for that migration. Open that file and append the
`ALTER TABLE` statement above at the end, then re-run `prisma migrate dev` (or
`prisma migrate deploy` in a non-interactive environment) so the constraint is
actually applied — Prisma will detect the migration file already exists and
apply it as-is rather than regenerating it. Do **not** run `prisma db push`
for this schema once the constraint exists, since `db push` doesn't preserve
hand-edited SQL in migration files.

The application layer (backend `Budget` mutations, written in the Phase 2 CRUD
work) must also enforce this XOR rule before hitting the database, so users
get a clear validation error instead of a raw Postgres constraint violation —
the DB constraint is the last line of defense, not the primary one.

## Commands to run once a real Neon connection string is available

```bash
# 1. Fill in .env: DATABASE_URL (pooled) and DIRECT_URL (direct) from Neon.

# 2. Generate the client (safe to re-run any time; already run once against
#    an empty DATABASE_URL-less environment during Phase 1 to confirm the
#    schema itself is valid).
npx prisma generate

# 3. Create and apply the first migration.
npx prisma migrate dev --name init

# 4. Hand-edit the generated prisma/migrations/<timestamp>_init/migration.sql
#    to append the budget_owner_xor CHECK constraint (see above), then:
npx prisma migrate dev

# 5. Seed a test user (test@butcem.app / Test1234!).
npx prisma db seed
# (equivalently: npm run db:seed)
```

## Extending the seed later (Phase 3)

`prisma/seed.ts` currently creates a single standalone `User` with no family.
When family (owner + member) seeding is added in Phase 3, keep the same
`upsert`-based idempotency pattern — the seed script should be safe to run
repeatedly against a database that already has data in it.
