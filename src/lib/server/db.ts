import "server-only";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Prisma 7 no longer reads a connection string embedded in schema.prisma at
 * generate-time; PrismaClient requires an explicit driver adapter at runtime.
 * We use the POOLED connection (DATABASE_URL) here — this is the client the
 * running app talks to on every request. Migrations use the DIRECT connection
 * (DIRECT_URL) via prisma.config.ts instead. See prisma/README.md.
 */
function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill in your Postgres connection string."
    );
  }

  const adapter = new PrismaPg(connectionString);

  return new PrismaClient({ adapter }).$extends(softDeleteExtension);
}

/**
 * Prisma Client Extension: transparently excludes soft-deleted rows
 * (`deletedAt IS NOT NULL`) from every read on the `Transaction` and
 * `Category` models, so call sites never have to remember to add the filter
 * themselves. This only covers reads — the "how do we soft-delete" helper
 * (`softDelete(...)`) is intentionally deferred to the Phase 2 CRUD work,
 * where the mutation call sites are actually written.
 *
 * Caveat for whoever writes that helper: `updateMany`/`deleteMany` are NOT
 * filtered here, since bulk mutations against soft-deleted rows are a
 * mutation-layer concern, not a read-layer one. Any bulk mutation added later
 * must add its own `deletedAt: null` guard in the `where` clause.
 *
 * ── ARCHITECTURAL CONSTRAINT: this filter does NOT cover nested reads ──
 *
 * Prisma Client Extensions' `query` component only intercepts *top-level*
 * calls on the model the hook is registered for (e.g. `db.transaction.
 * findMany(...)`). It does NOT intercept that same model being pulled in via
 * a nested `include`/`select` from a *different* model's query — this is a
 * documented Prisma limitation, not a bug in this extension, and it still
 * holds in Prisma 7. Concretely, none of these are filtered by the code
 * above, and would silently leak soft-deleted rows:
 *   - db.user.findUnique({ include: { transactions: true } })
 *   - db.user.findUnique({ include: { createdTransactions: true } })
 *   - db.user.findUnique({ include: { categories: true } })
 *   - db.family.findUnique({ include: { transactions: true } })
 *   - db.family.findUnique({ include: { categories: true } })
 *   - db.family.findUnique({ include: { members: { include: { user: {
 *       include: { transactions: true } } } } } })  (any depth)
 *   - db.category.findUnique({ include: { transactions: true } })
 *   - db.recurringTransaction.findMany({ include: { generated: true } })
 *
 * PROJECT RULE (decided by software-architect, binding for backend-developer
 * and data-science-engineer from Phase 2 onward): `Transaction` and
 * `Category` MUST always be queried as the top-level model —
 * `db.transaction.*` / `db.category.*` with `where: { userId }` and/or
 * `where: { familyId }` — never reached via `include`/`select` on `User`,
 * `Family`, `FamilyMember`, or `RecurringTransaction`. This is not just a
 * workaround: both models carry `userId`/`familyId` directly (see
 * schema.prisma), specifically so every legitimate query — personal
 * dashboard, family dashboard, reporting/aggregation — can be written this
 * way with no relation traversal needed. The reverse direction is fine and
 * expected: `db.transaction.findMany({ where: { userId }, include: {
 * category: true } })` is safe (Transaction is top-level here), and is
 * *intentionally* not soft-delete-filtered on the nested `category` — a
 * historical transaction should keep showing the name/icon of a category
 * that was later deleted, not go blank.
 *
 * How to verify once a real DB is connected (Phase 2+): soft-delete a
 * Category, then call `db.user.findUnique({ where: { id }, include: {
 * categories: true } })` and confirm the deleted row still comes back —
 * that reproduces the leak and confirms this comment, rather than assuming
 * it. If it does, it confirms nested-include access must stay banned; if a
 * future Prisma version changes this behavior, this comment (and the
 * project rule in CLAUDE.md) should be revisited.
 */
const softDeleteExtension = {
  name: "soft-delete-read-filter",
  query: {
    transaction: {
      async findMany({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async findFirst({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async findFirstOrThrow({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async findUnique({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async findUniqueOrThrow({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async count({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async aggregate({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async groupBy({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
    },
    category: {
      async findMany({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async findFirst({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async findFirstOrThrow({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async findUnique({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async findUniqueOrThrow({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async count({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async aggregate({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
      async groupBy({ args, query }: SoftDeleteArgs) {
        return query(withNotDeleted(args));
      },
    },
  },
};

type SoftDeleteArgs = {
  args: { where?: Record<string, unknown> | undefined } & Record<string, unknown>;
  query: (args: unknown) => Promise<unknown>;
};

function withNotDeleted<T extends { where?: Record<string, unknown> }>(args: T): T {
  return {
    ...args,
    where: {
      ...(args.where ?? {}),
      // Do not clobber an explicit deletedAt filter a caller passes on purpose
      // (e.g. an admin "show deleted" view added later).
      deletedAt: args.where && "deletedAt" in args.where ? args.where.deletedAt : null,
    },
  };
}

declare global {
  var __prisma: ReturnType<typeof createPrismaClient> | undefined;
}

/**
 * Singleton Prisma Client. Next.js dev mode hot-reloads server modules on
 * every save, which would otherwise create a new PrismaClient (and a new
 * connection pool) per reload. Caching on `globalThis` survives the reload.
 */
export const db = globalThis.__prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma = db;
}
