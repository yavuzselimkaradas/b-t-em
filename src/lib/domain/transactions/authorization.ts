// Framework-agnostic transaction authorization rules. No Next.js / Prisma
// imports here — this module is shared between the web app
// (src/lib/server/**) and the future mobile client (see barrel comment in
// lib/domain/index.ts).
//
// Moved here from src/lib/server/actions/transactions.ts (Phase 2 backend
// work) — that file has a top-level `"use server"` directive, and Next.js
// requires EVERY export of a `"use server"` module to be an async function
// (every export becomes a callable Server Action reference on the client
// bundle). `canEditTransaction` (originally `canMutateTransaction`, split
// from it once edit/delete grew different rules — see its own doc comment
// and `canDeleteTransaction` below) is a synchronous pure predicate, so
// exporting it alongside `createTransaction`/`updateTransaction`/etc. broke
// the module the moment anything client-side imported from it — surfaced
// while wiring up Aşama 2's transaction UI, which imports
// `TransactionWithCategory` and the mutation actions directly into Client
// Components, as the contract in CLAUDE.md's task doc calls for. Its
// original doc comment already described it as "no DB, no Next.js... so
// it's unit-testable in isolation" — exactly this layer's job. Flagged for
// backend-developer to confirm; functionally identical otherwise, just
// relocated.

/**
 * Pure authorization predicate for "may `actorUserId` EDIT (update) this
 * transaction?".
 *
 * Ownership-only, IDENTICAL for individual and family transactions — only
 * the record's own `userId` may ever edit it. Role (`OWNER`/`MEMBER`) is
 * irrelevant: an owner can edit their own family transactions but NOT
 * another member's, exactly as a member can edit their own but not the
 * owner's or a third member's. `transaction.familyId` doesn't need to be
 * inspected here — kept in the parameter shape only so callers can pass the
 * same row object they already have.
 *
 * Kept as a plain function over plain data (no DB, no Next.js) so it's
 * unit-testable in isolation.
 */
export function canEditTransaction(
  transaction: { userId: string; familyId?: string | null },
  actorUserId: string
): boolean {
  return transaction.userId === actorUserId;
}

/**
 * Pure authorization predicate for "may `actorUserId` REMOVE this
 * transaction FROM THE FAMILY VIEW?" (un-attribute it — clear whichever of
 * `familyId`/`sharedFamilyId` is set — WITHOUT touching `deletedAt`; see
 * `canDeleteTransactionEverywhere` below for the stricter, actually-deletes-
 * the-row predicate). Named `canDeleteTransaction` for historical reasons
 * (this used to BE the only delete predicate, before "remove from family"
 * vs. "delete everywhere" were split into two product actions — see the
 * task note this was updated under) — despite the name, calling this
 * "deletes" nothing by itself; callers wire it to whichever effect (un-attach
 * vs. full soft-delete) is appropriate. DELIBERATELY STRICTER than
 * `canEditTransaction` for anything family-related (product decision):
 * editing is ownership-only (see `canEditTransaction`), but removing a
 * family-associated row from the family view defaults to an OWNER-only
 * capability, independent of who created that specific row — UNLESS the
 * family's owner has explicitly opened up a narrow exception (see the
 * `familyId != null` bullet below).
 *
 *  - Real family transaction (`familyId != null`): the OWNER can always
 *    delete ANY of them, not just ones they personally created
 *    (`actorFamilyRole === "OWNER"` alone decides it for the owner). A
 *    MEMBER can delete one ONLY if BOTH (a) `membersCanDeleteOwnTransactions`
 *    is `true` for that family (an owner-controlled, default-off toggle —
 *    see `Family.membersCanDeleteOwnTransactions` in schema.prisma) AND
 *    (b) they are the row's own creator (`transaction.userId ===
 *    actorUserId`) — never another member's or the owner's row, even with
 *    the toggle on. `actorFamilyRole` must already be the caller's role IN
 *    THAT SPECIFIC family — this function trusts that and does not itself
 *    compare a family id (see `resolveTransactionForDeletion` in
 *    lib/server/actions/transactions.ts, which resolves the role scoped to
 *    the right family, and also resolves `membersCanDeleteOwnTransactions`
 *    scoped to that same family).
 *  - Not a family transaction (`familyId == null`) but SHARED into a
 *    family's view (`sharedFamilyId != null` — see
 *    `share-transactions-toggle.tsx`): its own creator (`userId ===
 *    actorUserId`) may always delete it — from their own `/transactions`
 *    page OR from the family dashboard, sharing never takes away a user's
 *    control over their own data — OR that family's OWNER may delete it
 *    too (same "owner moderates everything shown in their family's view"
 *    capability as the real-family-transaction case above; `actorFamilyRole`
 *    here must be resolved against `sharedFamilyId`, not `familyId`).
 *    UNCHANGED by `membersCanDeleteOwnTransactions` — that toggle only
 *    affects real family transactions (`familyId != null`), not this branch.
 *  - Neither family-attributed nor shared with any family: a plain private
 *    personal transaction — only its own `userId` may ever delete it, same
 *    as it always was before any family concept existed.
 */
export function canDeleteTransaction(
  transaction: { userId: string; familyId: string | null; sharedFamilyId?: string | null },
  actorUserId: string,
  actorFamilyRole: "OWNER" | "MEMBER" | null,
  membersCanDeleteOwnTransactions: boolean
): boolean {
  if (transaction.familyId !== null) {
    if (actorFamilyRole === "OWNER") return true;
    return (
      actorFamilyRole === "MEMBER" &&
      membersCanDeleteOwnTransactions &&
      transaction.userId === actorUserId
    );
  }
  if (transaction.userId === actorUserId) return true;
  if (transaction.sharedFamilyId) {
    return actorFamilyRole === "OWNER";
  }
  return false;
}

/**
 * Pure authorization predicate for "may `actorUserId` fully DELETE this
 * transaction EVERYWHERE (soft-delete — sets `deletedAt`, which removes it
 * from the family view AND the creator's own individual `/transactions`
 * view, since — per `buildTransactionWhere` in
 * lib/server/actions/transactions.ts, which filters only by `userId`, with
 * no `familyId` filter — a real family transaction and a shared individual
 * one are each a SINGLE row visible in both places, not separate copies)?
 *
 * STRICTLY NARROWER than `canDeleteTransaction` (which only gates "may
 * remove this row from the family view", i.e. null out `familyId` /
 * `sharedFamilyId` without ever touching `deletedAt`): full, everywhere
 * deletion is ONLY EVER available to a row's OWN creator
 * (`transaction.userId === actorUserId`), on top of still needing
 * `canDeleteTransaction` to hold. Concretely this means an OWNER may
 * REMOVE ANY member's family-attributed row FROM THE FAMILY VIEW (per
 * `canDeleteTransaction`'s `familyId != null` branch) but may NOT fully
 * delete another member's row — only their own. A MEMBER (with
 * `membersCanDeleteOwnTransactions` on) can only ever reach this for their
 * own row anyway, since `canDeleteTransaction` already requires
 * `transaction.userId === actorUserId` on that path — so this adds no
 * further restriction for members, only for the OWNER acting on someone
 * else's row.
 */
export function canDeleteTransactionEverywhere(
  transaction: { userId: string; familyId: string | null; sharedFamilyId?: string | null },
  actorUserId: string,
  actorFamilyRole: "OWNER" | "MEMBER" | null,
  membersCanDeleteOwnTransactions: boolean
): boolean {
  return (
    transaction.userId === actorUserId &&
    canDeleteTransaction(transaction, actorUserId, actorFamilyRole, membersCanDeleteOwnTransactions)
  );
}

/**
 * Pure authorization predicate for "may `actorUserId` CREATE a new family
 * transaction attributed to `targetUserId`?".
 *
 * Phase 3.3 scope decision (explicitly narrower than the eventual product
 * shape — see the task note in lib/server/actions/transactions.ts): "owner
 * adds a transaction on behalf of another member" (`targetUserId !==
 * actorUserId`) is NOT built this round, even though the schema already
 * supports the `userId`/`createdById` split needed for it. So for now:
 *  - `actorFamilyRole` must be non-null (the actor must actually be a member
 *    — OWNER or MEMBER — of the family the new transaction would belong to;
 *    same "caller resolves the role for the right family" contract as
 *    `canMutateTransaction`).
 *  - `targetUserId` must equal `actorUserId` — everyone, owner included,
 *    may only insert a family transaction under their own `userId` this
 *    round.
 */
export function canCreateFamilyTransaction(
  targetUserId: string,
  actorUserId: string,
  actorFamilyRole: "OWNER" | "MEMBER" | null
): boolean {
  return actorFamilyRole !== null && targetUserId === actorUserId;
}
