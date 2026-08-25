// Plain (non-`"use server"`) server-side module. Split out of
// lib/server/actions/transactions.ts for the same reason
// `canMutateTransaction`/`canCreateFamilyTransaction` were split out to
// lib/domain/transactions/authorization.ts: a module with a top-level
// `"use server"` directive must have EVERY export be an async function
// (Next.js turns every export into a callable Server Action reference on the
// client bundle) — `serializeTransaction` is a synchronous, pure function, so
// it cannot be exported from transactions.ts itself once a second file
// (lib/server/actions/family-transactions.ts, Aşama 3.5) also needs to call
// it. Not under lib/domain because it imports `Prisma`'s generated types
// directly (`Prisma.TransactionGetPayload`) — this stays a server-only
// (Prisma-aware) module, not the framework/ORM-agnostic domain layer.
import type { Prisma } from "@prisma/client";

/**
 * Shape returned by create/update/list — includes the related `category` so
 * the caller (frontend/mobile) can render the result immediately without a
 * refetch. Safe to nest `category` here because `Transaction` is the
 * top-level model in this query (see the soft-delete constraint documented
 * in lib/server/db.ts) — this is NOT reached via `include` on `User`/`Family`.
 */
export type TransactionWithCategory = Prisma.TransactionGetPayload<{
  include: { category: true };
}>;

/**
 * What actually goes out over a Server Action's wire, unlike
 * `TransactionWithCategory` — `amount` as a `string`, not a live
 * `Prisma.Decimal` class instance. React's "only plain objects can be
 * passed to Client Components" check flags a `Decimal` (it has methods,
 * isn't a plain object) even though `Decimal.toJSON()` happens to make it
 * *render* correctly regardless — the check still fires as a dev-console
 * error on every affected page. `serializeTransaction` below is the one
 * place this conversion happens; every mutation/read in
 * lib/server/actions/transactions.ts and
 * lib/server/actions/family-transactions.ts returns through it rather than a
 * bare Prisma result.
 *
 * Deliberately drops `deletedAt` and `removedFromFamilyAt` — internal
 * moderation/soft-delete bookkeeping columns, never read by any UI (verified
 * — no `.deletedAt`/`.removedFromFamilyAt` access anywhere under
 * `src/components`/`src/app`). `deletedAt` is always `null` here anyway (the
 * soft-delete Prisma extension already filters deleted rows out of every
 * query this flows through), so dropping it is low-stakes; `removedFromFamilyAt`
 * is the one that actually matters — leaving it in the wire shape let a
 * transaction's own creator see, via their OWN individual `/transactions`
 * response, the exact moment an OWNER silently removed that row from the
 * family view (`removeTransactionFromFamily`, lib/server/actions/
 * transactions.ts) — a moderation action nothing in the product currently
 * intends to surface to them. If a "removed from family" indicator is ever
 * wanted in the UI, add it back deliberately (a dedicated boolean, not the
 * raw timestamp) rather than relying on it leaking through the spread.
 */
export type SerializedTransaction = Omit<
  TransactionWithCategory,
  "amount" | "deletedAt" | "removedFromFamilyAt"
> & { amount: string };

export function serializeTransaction(transaction: TransactionWithCategory): SerializedTransaction {
  const {
    deletedAt: _deletedAt,
    removedFromFamilyAt: _removedFromFamilyAt,
    ...rest
  } = transaction;
  void _deletedAt;
  void _removedFromFamilyAt;
  return { ...rest, amount: transaction.amount.toString() };
}
