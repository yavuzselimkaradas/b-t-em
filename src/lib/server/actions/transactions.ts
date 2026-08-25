"use server";

import { Prisma, type Currency, type TransactionType } from "@prisma/client";

import { db } from "@/lib/server/db";
import { auth } from "@/lib/server/auth";
import {
  canCreateFamilyTransaction,
  canDeleteTransaction,
  canDeleteTransactionEverywhere,
  canEditTransaction,
  summarize,
} from "@/lib/domain/transactions";
import {
  transactionFiltersSchema,
  transactionIdSchema,
  transactionSchema,
  transactionUpdateSchema,
  type TransactionInput,
} from "@/lib/validation/transaction";
import {
  serializeTransaction,
  type SerializedTransaction,
  type TransactionWithCategory,
} from "@/lib/server/serializers/transaction";

// STABLE KEYS (`errors.<camelCase>`), not translated text — this file never
// imports next-intl; the client resolves these via `messages/{locale}.json`'s
// `errors` namespace. `errors.unauthenticated` / `errors.validationFailed` /
// `errors.categoryNotFound` / `errors.noFieldsToUpdate` are shared with
// other action files (identical Turkish source text) — see each constant's
// comment for what stays file-specific vs. deduped.
const UNAUTHENTICATED_MESSAGE = "errors.unauthenticated";
const NOT_FOUND_MESSAGE = "errors.transactionNotFound";
// Shared with lib/server/actions/budgets.ts's own `CATEGORY_NOT_FOUND_MESSAGE`
// (identical source text: "Seçilen kategori bulunamadı.") — deduped to one key.
const CATEGORY_NOT_FOUND_MESSAGE = "errors.categoryNotFound";
const CATEGORY_TYPE_MISMATCH_MESSAGE = "errors.transactionCategoryTypeMismatch";
const VALIDATION_ERROR_MESSAGE = "errors.validationFailed";
const FILTER_ERROR_MESSAGE = "errors.invalidFilters";
// Shared with lib/server/actions/budgets.ts's own `NO_FIELDS_MESSAGE`
// (identical source text: "Güncellenecek bir alan girin.") — deduped.
const NO_FIELDS_MESSAGE = "errors.noFieldsToUpdate";
// Deliberately a DIFFERENT key from categories.ts's own
// `NOT_FAMILY_MEMBER_MESSAGE` ("Bu aile için kategori oluşturamazsınız.") —
// different source text (transaction vs. category wording), not a dedup case.
const NOT_FAMILY_MEMBER_MESSAGE = "errors.notFamilyMemberTransaction";
/** Same lock as `SHARING_LOCKED_BY_OWNER_MESSAGE` (lib/server/actions/family.ts,
 * `updateTransactionSharing`), extended to `removeTransactionFromFamily` —
 * see `assertCanRemoveFromFamily`'s doc comment for the full reasoning. NOT
 * a generic "not found": the actor here is always acting on a row they
 * already own/see (their own transaction), so there is no id-enumeration
 * risk in naming the real reason, same tone/precedent as the sharing-lock
 * message it mirrors. */
const REMOVE_FROM_FAMILY_LOCKED_MESSAGE = "errors.removeFromFamilyLocked";

const DEFAULT_PAGE_SIZE = 20;
/** Sanity ceiling for exports — see `TransactionExportResult`'s doc comment
 * in lib/client/transaction-view-model.ts for why this isn't a product limit. */
const EXPORT_ROW_CAP = 5000;

export type TransactionFieldErrors = Partial<Record<keyof TransactionInput, string[]>>;

// `TransactionWithCategory` / `SerializedTransaction` / `serializeTransaction`
// now live in lib/server/serializers/transaction.ts (imported above) — moved
// out for the same reason `canMutateTransaction` was moved to
// lib/domain/transactions/authorization.ts: every export of a `"use server"`
// module must be an async function, and `serializeTransaction` needed to be
// callable from lib/server/actions/family-transactions.ts (Aşama 3.5) too.
// Re-exported here so any existing import of these two TYPES from this file
// keeps working unchanged.
export type { SerializedTransaction, TransactionWithCategory };

export type TransactionActionResult =
  | { success: true; data: SerializedTransaction }
  | { success: false; error: string; fieldErrors?: TransactionFieldErrors };

export type SoftDeleteResult = { success: true } | { success: false; error: string };

/** One currency's totals in a `TransactionSummaryResult` — the serialized
 * (`Decimal.toString()`) counterpart of `PerCurrencyTotal`
 * (lib/domain/transactions/aggregate.ts). Replaces the old single-currency
 * `TransactionSummaryData` (roadmap "Çoklu Para Birimi" fix — summing TRY
 * and USD amounts together was a bug, not a simplification; see that
 * aggregate module's updated `summarize` doc comment for the full
 * reasoning). `TRY` is always present in the array (even `"0"` totals),
 * other currencies only when the matched transactions actually used them —
 * NEVER converted into one another; each entry is that currency's own raw
 * total. */
export interface PerCurrencySummaryData {
  currency: Currency;
  totalIncome: string;
  totalExpense: string;
  net: string;
}

export type TransactionSummaryResult =
  | { success: true; data: PerCurrencySummaryData[] }
  | { success: false; error: string };

export type TransactionExportResult =
  | { success: true; data: SerializedTransaction[]; truncated?: boolean }
  | { success: false; error: string };

export type ListTransactionsResult =
  | {
      success: true;
      data: {
        items: SerializedTransaction[];
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
      };
    }
  | { success: false; error: string };

// ── Authorization ────────────────────────────────────────────────────────
//
// `canMutateTransaction` itself now lives in lib/domain/transactions
// (framework-agnostic, shared with mobile) — NOT exported from this file.
// A file with a top-level `"use server"` directive must have every export
// be an async function (each export becomes a callable Server Action
// reference on the client bundle); a synchronous pure predicate exported
// here breaks the module for any Client Component that imports from it. See
// lib/domain/transactions/authorization.ts for the full note.

/**
 * Fetches a transaction by id — shared by `assertCanEditTransaction` and
 * `resolveTransactionForDeletion` below (in turn shared by
 * `assertCanRemoveFromFamily` and `assertCanDeleteEverywhere`), which apply
 * different predicates to the same row (see
 * `canEditTransaction`/`canDeleteTransaction`/`canDeleteTransactionEverywhere`'s
 * doc comments in lib/domain/transactions/authorization.ts for why edit and
 * delete diverge: removing anything family-associated FROM THE FAMILY VIEW
 * — a real family transaction OR one merely shared into a family's view —
 * is an OWNER-only capability, independent of who created that row, while
 * FULLY deleting a row is always restricted to its own creator; editing
 * stays ownership-only throughout). `sharedFamilyId` is selected alongside
 * `familyId` for exactly that delete rule's sake.
 *
 * `db.transaction.findUnique` is already soft-delete-filtered by the
 * extension in lib/server/db.ts, so a soft-deleted row also lands here as
 * "not found" for free.
 */
async function fetchTransactionForMutation(id: string) {
  return db.transaction.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      familyId: true,
      sharedFamilyId: true,
      type: true,
      categoryId: true,
    },
  });
}

/**
 * Fetches a transaction and applies `canEditTransaction`. Returns a
 * generic "not found" error — not "forbidden" — for both "doesn't exist"
 * and "exists but isn't yours", so a transaction id can't be used to probe
 * whether it belongs to someone else.
 *
 * Ownership-only rule, identical for individual and family transactions:
 * only `transaction.userId === actorUserId` can ever edit it, regardless of
 * `familyId` or the actor's role in that family — no `FamilyMember` lookup
 * needed, a plain `userId` comparison is the whole check.
 */
async function assertCanEditTransaction(id: string, actorUserId: string) {
  const transaction = await fetchTransactionForMutation(id);

  if (!transaction || !canEditTransaction(transaction, actorUserId)) {
    return { ok: false as const, error: NOT_FOUND_MESSAGE };
  }

  return { ok: true as const, transaction };
}

/**
 * Fetches a transaction plus everything needed to evaluate EITHER delete
 * predicate against it (`canDeleteTransaction` — "remove from family view"
 * — or `canDeleteTransactionEverywhere` — "fully delete"; see
 * `assertCanRemoveFromFamily`/`assertCanDeleteEverywhere` below, the two
 * callers of this helper, one per predicate). Shared so both Server Actions
 * do the exact same row fetch + role resolution and only diverge on which
 * predicate they apply.
 *
 * The actor's role is looked up against whichever family the row is
 * ASSOCIATED with — `familyId` for a real family transaction, or
 * `sharedFamilyId` for one merely shared into a family's view (never both;
 * see the `Transaction` model's doc comment in schema.prisma — a row is
 * only ever one or the other) — via a DIRECT `db.familyMember.findUnique`
 * call (never a nested include on `User`/`Family` — CLAUDE.md) keyed on the
 * compound `[familyId, userId]` unique index. If the actor has no
 * `FamilyMember` row for that family, `actorFamilyRole` is `null`, which
 * both predicates treat the same as an explicit MEMBER role. A plain
 * private transaction (neither `familyId` nor `sharedFamilyId` set) skips
 * this lookup entirely for `actorFamilyRole`/`membersCanDeleteOwnTransactions`
 * — role is irrelevant there, only ownership matters for either predicate.
 *
 * The SAME `db.familyMember.findUnique` call also selects the family's
 * `membersCanDeleteOwnTransactions` AND `forceShareIndividualTransactions`
 * toggles via a nested `select: { family: { select: { ... } } } }` — safe
 * under CLAUDE.md's soft-delete rule since this reaches `Family`, not
 * `Transaction`/`Category`. `forceShareIndividualTransactions` is only
 * consumed by `assertCanRemoveFromFamily` below (see its doc comment) —
 * unused by `assertCanDeleteEverywhere`, but resolved here anyway since both
 * share this one query. For a plain private row (`relevantFamilyId === null`)
 * that is STILL the actor's own, a SEPARATE fallback lookup resolves
 * `forceShareIndividualTransactions` from the actor's current family
 * membership regardless — see the `else if` branch below: such a row can be
 * visible in the family view purely via the force-share arm (which never
 * touches the row's own columns), so the lock must still apply to it.
 *
 * Returns `null` (not an error shape) when the row itself doesn't exist —
 * callers turn that into the generic `NOT_FOUND_MESSAGE` themselves, kept
 * out of this helper so it stays a pure "resolve the inputs" step.
 */
async function resolveTransactionForDeletion(id: string, actorUserId: string) {
  const transaction = await fetchTransactionForMutation(id);
  if (!transaction) {
    return null;
  }

  const relevantFamilyId = transaction.familyId ?? transaction.sharedFamilyId ?? null;
  let actorFamilyRole: "OWNER" | "MEMBER" | null = null;
  let membersCanDeleteOwnTransactions = false;
  let forceShareIndividualTransactions = false;
  if (relevantFamilyId !== null) {
    const membership = await db.familyMember.findUnique({
      where: { familyId_userId: { familyId: relevantFamilyId, userId: actorUserId } },
      select: {
        role: true,
        family: {
          select: { membersCanDeleteOwnTransactions: true, forceShareIndividualTransactions: true },
        },
      },
    });
    actorFamilyRole = membership?.role ?? null;
    membersCanDeleteOwnTransactions = membership?.family.membersCanDeleteOwnTransactions ?? false;
    forceShareIndividualTransactions = membership?.family.forceShareIndividualTransactions ?? false;
  } else if (transaction.userId === actorUserId) {
    // The row itself carries NO family attribution (`familyId` and
    // `sharedFamilyId` both null — never a real family transaction, never
    // explicitly shared) — but it can STILL be showing up in the actor's own
    // family's view purely through the force-share kill switch
    // (`buildFamilyTransactionWhere`'s arm 3, family-transactions.ts), which
    // matches on live family membership + `userId`, never touching this
    // row's own columns. Resolve the actor's CURRENT family membership (at
    // most one — `FamilyMember.@@unique([userId])`) purely so
    // `assertCanRemoveFromFamily`'s lock check below still applies to this
    // case, instead of silently no-op-"succeeding" on a row that's actually
    // still visible in the family view (found in QA review, 2026-08-21).
    // Not gated on `transaction.userId === actorUserId` for correctness —
    // it's an optimization: `canDeleteTransaction`'s only path to `true` for
    // a `relevantFamilyId === null` row already requires this same equality,
    // so skipping the query for anyone else's row costs nothing.
    const ownMembership = await db.familyMember.findFirst({
      where: { userId: actorUserId },
      select: { family: { select: { forceShareIndividualTransactions: true } } },
    });
    forceShareIndividualTransactions = ownMembership?.family.forceShareIndividualTransactions ?? false;
  }

  return {
    transaction,
    actorFamilyRole,
    membersCanDeleteOwnTransactions,
    forceShareIndividualTransactions,
  };
}

/**
 * Fetches a transaction and applies `canDeleteTransaction` — "may
 * `actorUserId` remove this row FROM THE FAMILY VIEW" (un-attribute
 * `familyId`/`sharedFamilyId`, `deletedAt` untouched). Same generic "not
 * found" discipline as `assertCanEditTransaction`: a non-authorized caller
 * or a non-existent id both return the same error, so an id can't be used
 * to probe whether it belongs to someone else. Backs `removeTransactionFromFamily`.
 *
 * Force-share lock (new): on TOP of `canDeleteTransaction` passing, a
 * `MEMBER` (never the `OWNER`) whose family currently has
 * `forceShareIndividualTransactions` on is blocked from removing THEIR OWN
 * row from the family view — same lock `updateTransactionSharing`
 * (lib/server/actions/family.ts) already applies to the sharing toggle
 * itself, extended here so a member can't use "remove from family" as a
 * per-transaction end-run around it (the switch's whole point is that a
 * member can't selectively hide things from the owner). This does NOT apply
 * to an `OWNER` removing another member's row — that path is exactly what
 * this action is for (see the doc comment above `removeTransactionFromFamily`)
 * and is unaffected by the switch, which only ever constrains members, never
 * the owner. Unlike the rest of this function's "not found" discipline, this
 * ONE rejection uses a distinct, explicit message
 * (`REMOVE_FROM_FAMILY_LOCKED_MESSAGE`) rather than `NOT_FOUND_MESSAGE` —
 * safe to be explicit here since the actor reaching this branch is, by
 * construction, acting on their OWN transaction (the only way
 * `canDeleteTransaction` lets a MEMBER through at all), so there is no
 * enumeration risk in confirming the row exists and naming the real reason
 * — identical reasoning to `SHARING_LOCKED_BY_OWNER_MESSAGE`.
 */
async function assertCanRemoveFromFamily(id: string, actorUserId: string) {
  const resolved = await resolveTransactionForDeletion(id, actorUserId);
  if (!resolved) {
    return { ok: false as const, error: NOT_FOUND_MESSAGE };
  }

  const {
    transaction,
    actorFamilyRole,
    membersCanDeleteOwnTransactions,
    forceShareIndividualTransactions,
  } = resolved;
  if (
    !canDeleteTransaction(transaction, actorUserId, actorFamilyRole, membersCanDeleteOwnTransactions)
  ) {
    return { ok: false as const, error: NOT_FOUND_MESSAGE };
  }

  if (actorFamilyRole !== "OWNER" && forceShareIndividualTransactions) {
    return { ok: false as const, error: REMOVE_FROM_FAMILY_LOCKED_MESSAGE };
  }

  return { ok: true as const, transaction };
}

/**
 * Fetches a transaction and applies `canDeleteTransactionEverywhere` — "may
 * `actorUserId` fully delete this row (`deletedAt` set), removing it from
 * BOTH the family view and their own individual `/transactions` view".
 * STRICTER than `assertCanRemoveFromFamily`: only ever true for the row's
 * OWN creator, even for an OWNER acting on another member's
 * family-attributed row (an owner may still remove any such row from the
 * family view via `assertCanRemoveFromFamily`, just not fully delete it).
 * Same generic "not found" discipline. Backs `softDeleteTransaction`.
 */
async function assertCanDeleteEverywhere(id: string, actorUserId: string) {
  const resolved = await resolveTransactionForDeletion(id, actorUserId);
  if (!resolved) {
    return { ok: false as const, error: NOT_FOUND_MESSAGE };
  }

  const { transaction, actorFamilyRole, membersCanDeleteOwnTransactions } = resolved;
  if (
    !canDeleteTransactionEverywhere(
      transaction,
      actorUserId,
      actorFamilyRole,
      membersCanDeleteOwnTransactions
    )
  ) {
    return { ok: false as const, error: NOT_FOUND_MESSAGE };
  }

  return { ok: true as const, transaction };
}

/**
 * Confirms `categoryId` both exists and is usable by `userId`, and that its
 * `type` (income/expense) matches the transaction's `type`.
 *
 * "Usable": the seeded defaults (`isDefault: true`, `userId`/`familyId`
 * null), OR the caller's own personal category (`category.userId ===
 * userId`), OR — when `familyId` is passed (the transaction being
 * created/updated is itself family-attributed) — a category shared by that
 * same family (`category.familyId === familyId`). `familyId` here is always
 * the TRANSACTION's family, already authorized by the caller
 * (`createTransaction`'s own membership check, or `assertOwnsTransaction`'s
 * ownership check for an update) — this function does not re-verify family
 * membership itself, only that the category actually belongs to that
 * family.
 *
 * `db.category.findUnique` is soft-delete-filtered by the extension in
 * lib/server/db.ts, so a soft-deleted category also lands here as "not
 * found" — correct for NEW/updated transactions, which must not attach to a
 * deleted category even though EXISTING transactions keep displaying a
 * later-deleted category's name (see db.ts for why that's intentional).
 */
async function assertUsableCategory(
  categoryId: string,
  type: TransactionType,
  userId: string,
  familyId: string | null
): Promise<{ ok: true } | { ok: false; error: string; fieldErrors: TransactionFieldErrors }> {
  const category = await db.category.findUnique({
    where: { id: categoryId },
    select: { userId: true, familyId: true, isDefault: true, type: true },
  });

  const exists =
    category &&
    (category.isDefault ||
      category.userId === userId ||
      (familyId !== null && category.familyId === familyId));
  if (!exists) {
    return {
      ok: false,
      error: CATEGORY_NOT_FOUND_MESSAGE,
      fieldErrors: { categoryId: [CATEGORY_NOT_FOUND_MESSAGE] },
    };
  }

  if (category.type !== type) {
    return {
      ok: false,
      error: CATEGORY_TYPE_MISMATCH_MESSAGE,
      fieldErrors: { categoryId: [CATEGORY_TYPE_MISMATCH_MESSAGE] },
    };
  }

  return { ok: true };
}

// ── Mutations ────────────────────────────────────────────────────────────

/**
 * Server Action: creates a Transaction owned by the signed-in user, either
 * individual (`familyId` omitted) or attributed to a family they belong to.
 *
 * Contract (relied on by frontend-developer / mobile-developer):
 *  - Input: a plain object shaped like `TransactionInput`
 *    ({ type, amount, currency, categoryId, description?, date, familyId? }).
 *    Treated as fully untrusted regardless of client-side form validation —
 *    re-validated here with `transactionSchema`.
 *  - Auth: requires a session (`auth()`); returns `{ success: false }` with
 *    a generic message if absent. `userId` / `createdById` are ALWAYS
 *    derived from the session, never from the input, even if the caller
 *    sends them — this holds regardless of `familyId` too: Aşama 3.3
 *    explicitly does NOT support "owner adds a transaction on behalf of
 *    another member" yet (see `canCreateFamilyTransaction`'s doc comment in
 *    lib/domain/transactions/authorization.ts), so every family transaction
 *    is still attributed to whoever is calling this, never a different
 *    member.
 *  - `familyId` (new, Aşama 3.3): optional. Omitted (or not present) →
 *    unchanged Phase 2 behavior, an individual transaction (`familyId:
 *    null` in the DB). If present, the caller's membership in THAT family
 *    is verified with a direct `db.familyMember.findUnique` call (never a
 *    nested include on `User`/`Family` — CLAUDE.md) via
 *    `canCreateFamilyTransaction`; a non-member (including someone who is a
 *    member of a *different* family) gets a distinct, explicit
 *    "Bu aile için işlem oluşturamazsınız." error — unlike the
 *    ownership/not-found checks elsewhere in this file, this is a brand-new
 *    resource being created, so there's no existing row identity to protect
 *    by staying generic.
 *  - Output: `TransactionActionResult`. On success, `{ success: true, data }`
 *    where `data` includes the nested `category`. On validation failure,
 *    `{ success: false, error, fieldErrors }` mirroring Zod's
 *    `flatten().fieldErrors`, keyed by `TransactionInput`'s fields. On an
 *    invalid/foreign category, `{ success: false, error, fieldErrors:
 *    { categoryId: [...] } }`.
 */
export async function createTransaction(input: unknown): Promise<TransactionActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsed = transactionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as TransactionFieldErrors,
    };
  }

  const { type, amount, currency, categoryId, description, date, familyId } = parsed.data;

  if (familyId) {
    const membership = await db.familyMember.findUnique({
      where: { familyId_userId: { familyId, userId: session.user.id } },
      select: { role: true },
    });
    const actorFamilyRole = membership?.role ?? null;
    if (!canCreateFamilyTransaction(session.user.id, session.user.id, actorFamilyRole)) {
      return { success: false, error: NOT_FAMILY_MEMBER_MESSAGE };
    }
  }

  const categoryCheck = await assertUsableCategory(
    categoryId,
    type,
    session.user.id,
    familyId ?? null
  );
  if (!categoryCheck.ok) {
    return { success: false, error: categoryCheck.error, fieldErrors: categoryCheck.fieldErrors };
  }

  // A PERSONAL transaction (no `familyId`) gets permanently stamped with
  // `sharedFamilyId` at creation time, reflecting the caller's
  // `FamilyMember.shareIndividualTransactions` preference AT THIS MOMENT —
  // not re-evaluated later. Toggling that preference off/on afterwards
  // (`updateTransactionSharing`, lib/server/actions/family.ts) only changes
  // what NEW transactions get stamped with; it never retroactively shows or
  // hides transactions already created. A transaction created with an
  // explicit `familyId` is already family-scoped, so this stays null there.
  let sharedFamilyId: string | null = null;
  if (!familyId) {
    const ownMembership = await db.familyMember.findFirst({
      where: { userId: session.user.id, shareIndividualTransactions: true },
      select: { familyId: true },
    });
    sharedFamilyId = ownMembership?.familyId ?? null;
  }

  try {
    const transaction = await db.transaction.create({
      data: {
        type,
        amount,
        currency,
        categoryId,
        description,
        date,
        userId: session.user.id,
        createdById: session.user.id,
        familyId: familyId ?? null,
        sharedFamilyId,
      },
      include: { category: true },
    });

    return { success: true, data: serializeTransaction(transaction) };
  } catch (error) {
    // categoryId passed the existence check above but was deleted/changed by
    // a concurrent request before this insert ran — surface a friendly,
    // field-scoped error instead of a raw FK-violation message.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      return {
        success: false,
        error: CATEGORY_NOT_FOUND_MESSAGE,
        fieldErrors: { categoryId: [CATEGORY_NOT_FOUND_MESSAGE] },
      };
    }
    throw error;
  }
}

/**
 * Server Action: updates a Transaction the signed-in user is authorized to
 * mutate.
 *
 * Contract:
 *  - `id`: the transaction id (validated as a cuid; any other shape is
 *    treated the same as "not found", never a distinct error).
 *  - `input`: a PARTIAL `TransactionInput`, minus `familyId` (see
 *    `transactionUpdateSchema`'s doc comment in lib/validation/transaction.ts
 *    — re-attributing a transaction between individual/family is not
 *    supported via update) — only send the fields that changed. Every field,
 *    if present, is re-validated with the same rules as `createTransaction`.
 *  - Auth + authorization: requires a session AND `canEditTransaction`
 *    (lib/domain/transactions) to return true for the existing row, checked
 *    via `assertCanEditTransaction`. Ownership-only rule, identical for
 *    individual and family transactions: only the row's own `userId` may
 *    edit it — an owner can edit their own family transactions but NOT
 *    another member's, and a member likewise only their own, never the
 *    owner's or a different member's. Unlike delete (`softDeleteTransaction`
 *    below), this does NOT additionally require `OWNER` for a family
 *    transaction — a member may edit their own. A non-authorized caller or a
 *    non-existent id both return the same generic "not found" error, so an
 *    id can't be used to probe whether it belongs to someone else.
 *  - If `categoryId` and/or `type` are being changed, the resulting
 *    (categoryId, type) pair is re-validated against `Category.type` — you
 *    cannot attach an expense category to an income transaction, or vice
 *    versa. The category-usability check is family-aware: a family
 *    transaction may use that family's shared categories, not just the
 *    caller's personal ones.
 *  - Output: `TransactionActionResult`, same shape as `createTransaction`.
 */
export async function updateTransaction(
  id: string,
  input: unknown
): Promise<TransactionActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const idResult = transactionIdSchema.safeParse(id);
  if (!idResult.success) {
    return { success: false, error: NOT_FOUND_MESSAGE };
  }
  const transactionId = idResult.data;

  // Ownership check BEFORE validating `input`'s body: a non-owner should get
  // the same "not found" response regardless of what they sent, and we
  // avoid doing extra validation work for a request that's going to be
  // rejected anyway.
  const ownership = await assertCanEditTransaction(transactionId, session.user.id);
  if (!ownership.ok) {
    return { success: false, error: ownership.error };
  }

  const parsed = transactionUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as TransactionFieldErrors,
    };
  }

  if (Object.keys(parsed.data).length === 0) {
    return { success: false, error: NO_FIELDS_MESSAGE };
  }

  // Category.type must always agree with Transaction.type — re-check
  // whichever of the two changed against the (possibly unchanged) other one.
  if (parsed.data.categoryId || parsed.data.type) {
    const effectiveType = parsed.data.type ?? ownership.transaction.type;
    const effectiveCategoryId = parsed.data.categoryId ?? ownership.transaction.categoryId;
    const categoryCheck = await assertUsableCategory(
      effectiveCategoryId,
      effectiveType,
      session.user.id,
      ownership.transaction.familyId
    );
    if (!categoryCheck.ok) {
      return {
        success: false,
        error: categoryCheck.error,
        fieldErrors: categoryCheck.fieldErrors,
      };
    }
  }

  try {
    const transaction = await db.transaction.update({
      // `deletedAt: null` guard (Prisma's "extended where unique input"):
      // closes the race where the row is soft-deleted by another request
      // between the ownership check above and this update — without it,
      // an update could silently "resurrect" fields on an already-deleted
      // row instead of failing.
      where: { id: transactionId, deletedAt: null },
      data: parsed.data,
      include: { category: true },
    });

    return { success: true, data: serializeTransaction(transaction) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        // Row vanished (concurrent soft-delete) between the checks above and
        // this update.
        return { success: false, error: NOT_FOUND_MESSAGE };
      }
      if (error.code === "P2003") {
        return {
          success: false,
          error: CATEGORY_NOT_FOUND_MESSAGE,
          fieldErrors: { categoryId: [CATEGORY_NOT_FOUND_MESSAGE] },
        };
      }
    }
    throw error;
  }
}

/**
 * Server Action: FULLY soft-deletes a Transaction EVERYWHERE (sets
 * `deletedAt`; NEVER calls `.delete()`) — removes it from BOTH the family
 * view (if any) AND the creator's own individual `/transactions` view,
 * since they're the same underlying row (see
 * `canDeleteTransactionEverywhere`'s doc comment,
 * lib/domain/transactions/authorization.ts). ONLY EVER available for the
 * row's OWN creator — see below. If the caller instead wants to remove a
 * family-attributed row from the family view WITHOUT deleting it (leaving
 * it intact in the creator's own individual view), use
 * `removeTransactionFromFamily` instead, which this action does NOT call
 * and is not a superset of.
 *
 * Contract:
 *  - `id`: same id validation as `updateTransaction`, but a DIFFERENT,
 *    family-aware authorization check — `id` is checked via
 *    `assertCanDeleteEverywhere`/`canDeleteTransactionEverywhere`
 *    (lib/domain/transactions), not `assertCanEditTransaction`.
 *      - ALWAYS ownership-only, regardless of `familyId`/`sharedFamilyId`:
 *        only `transaction.userId === actorUserId` may fully delete a row —
 *        on top of that, whatever `canDeleteTransaction` would additionally
 *        require for that row (OWNER role for a family/shared row, or the
 *        `membersCanDeleteOwnTransactions` toggle for a member's own family
 *        row) must ALSO hold. Practically: an OWNER can NEVER fully delete
 *        another member's row this way — even though they CAN remove it
 *        from the family view via `removeTransactionFromFamily` — only
 *        their own rows. A MEMBER (with `membersCanDeleteOwnTransactions`
 *        on) can only ever ask this for their own row anyway. A plain
 *        private transaction (no `familyId`/`sharedFamilyId`): only its own
 *        `userId`, as always.
 *    A non-authorized caller or a non-existent id both return the same
 *    generic "not found" error.
 *  - Idempotent: soft-deleting an already-deleted (or already-gone) id
 *    returns `{ success: true }`, not an error — calling this twice (double
 *    click, retry) must not surface as a failure.
 *  - Output: `SoftDeleteResult` = `{ success: true } | { success: false,
 *    error: string }`. There is no `data` payload on success.
 */
export async function softDeleteTransaction(id: string): Promise<SoftDeleteResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const idResult = transactionIdSchema.safeParse(id);
  if (!idResult.success) {
    return { success: false, error: NOT_FOUND_MESSAGE };
  }
  const transactionId = idResult.data;

  const ownership = await assertCanDeleteEverywhere(transactionId, session.user.id);
  if (!ownership.ok) {
    return { success: false, error: ownership.error };
  }

  try {
    // `deletedAt: null` in the WHERE (not just in the ownership pre-check)
    // makes this an atomic, race-safe, idempotent guard: two concurrent
    // soft-deletes can both pass the ownership check, but only the first
    // `UPDATE ... WHERE id = ? AND deletedAt IS NULL` actually matches a
    // row. The second matches zero rows (P2025 below), which we treat as a
    // benign no-op rather than an error.
    await db.transaction.update({
      where: { id: transactionId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return { success: true };
    }
    throw error;
  }
}

/**
 * Server Action: removes a Transaction FROM THE FAMILY VIEW ONLY — clears
 * whichever of `familyId` (a real family transaction) or `sharedFamilyId`
 * (an individual transaction merely shared into a family's view) is set on
 * the row, WITHOUT ever touching `deletedAt`. The row itself is NOT
 * deleted: it keeps existing, unaffected, in its creator's own individual
 * `/transactions` view (that page's `buildTransactionWhere` filters only by
 * `userId`, so a now-unattributed row simply continues to show there as a
 * plain personal transaction — see this file's soft-delete note in
 * CLAUDE.md's project instructions). Use `softDeleteTransaction` instead if
 * the caller wants to fully delete the row everywhere (only ever available
 * to the row's own creator).
 *
 * Contract (relied on by frontend-developer / mobile-developer):
 *  - `id`: same id validation as `softDeleteTransaction`
 *    (`transactionIdSchema`; any other shape is treated as "not found").
 *  - Auth + authorization: requires a session AND
 *    `assertCanRemoveFromFamily`/`canDeleteTransaction`
 *    (lib/domain/transactions) — the SAME predicate `softDeleteTransaction`
 *    used to use before the "remove from family" vs. "delete everywhere"
 *    split (see that predicate's doc comment for the full per-case
 *    breakdown: OWNER can act on ANY family/shared row, a MEMBER only their
 *    own with `membersCanDeleteOwnTransactions` on, a plain private
 *    transaction only its own creator). A non-authorized caller or a
 *    non-existent id both return the same generic "not found" error.
 *  - Force-share lock (new): on top of the predicate above, if the caller
 *    is a `MEMBER` (never the `OWNER`) of the relevant family AND that
 *    family's `forceShareIndividualTransactions` switch is currently on,
 *    the request is rejected with a distinct, explicit
 *    `REMOVE_FROM_FAMILY_LOCKED_MESSAGE` — NOT the generic "not found" —
 *    since the caller is always acting on a row they already own/see, so
 *    naming the real reason carries no id-enumeration risk (same precedent
 *    as `SHARING_LOCKED_BY_OWNER_MESSAGE` in
 *    lib/server/actions/family.ts). Mirrors that same lock so a MEMBER
 *    can't use "remove from family" as a per-transaction end-run around it.
 *    See `assertCanRemoveFromFamily`'s doc comment for exactly which rows
 *    this can and can't reach (in short: only ones that would actually
 *    change something — see the no-op bullet below — so a harmless retry
 *    is never newly blocked by this).
 *  - No-op guard: if the row already has NEITHER `familyId` nor
 *    `sharedFamilyId` set — i.e. removing it from the family view wouldn't
 *    change anything, because it's either always been a plain private
 *    transaction or was already removed by a previous call to this same
 *    action — this returns `{ success: true }` without issuing any DB
 *    write or applying the force-share lock above (there's nothing for the
 *    lock to protect once the row is already outside the family view).
 *    REACHABLE in practice, not just defensive: see the inline comment
 *    where this is computed for why every path here is always the
 *    caller's own row.
 *  - `deletedAt: null` guard in the WHERE clause, same race-safety purpose
 *    as `softDeleteTransaction`'s (a row soft-deleted by a concurrent
 *    request between the ownership check and this update must not be
 *    silently un-attributed).
 *  - Idempotency, precisely: two concurrent calls (double-click) on the
 *    SAME row race safely — only one issues the actual `UPDATE`, the other
 *    hits the `deletedAt: null` WHERE-clause guard (P2025 below) and is
 *    treated as a benign no-op. A call that finds the row ALREADY
 *    un-attributed (whether it always was, or a PRIOR, separately-committed
 *    call already un-attributed it) also returns `{ success: true }` via
 *    the no-op guard above — that combination covers same-request races and
 *    "the goal state already holds" retries. What this does NOT guarantee:
 *    a genuinely independent retry AFTER a full prior commit, made when the
 *    authorization inputs have since changed (e.g. the row was removed by
 *    someone else in between, so `assertCanRemoveFromFamily` no longer
 *    resolves the same role/rights for it) can still return
 *    `NOT_FOUND_MESSAGE` — an accepted terminal outcome for delete-like
 *    semantics generally (`softDeleteTransaction` behaves the same way for
 *    the analogous case, since the soft-delete extension in
 *    lib/server/db.ts filters an already-`deletedAt`-set row out of
 *    `findUnique` too).
 *  - Output: `SoftDeleteResult` (`{ success: true } | { success: false,
 *    error: string }`) — DELIBERATELY the exact same type as
 *    `softDeleteTransaction`'s, so `DeleteTransactionDialog`'s existing
 *    `onDelete: (transactionId: string) => Promise<TransactionDeleteResult>`
 *    prop (lib/client/transaction-view-model.ts) can point at this action
 *    directly with no new prop/type needed.
 */
export async function removeTransactionFromFamily(id: unknown): Promise<SoftDeleteResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const idResult = transactionIdSchema.safeParse(id);
  if (!idResult.success) {
    return { success: false, error: NOT_FOUND_MESSAGE };
  }
  const transactionId = idResult.data;

  const ownership = await assertCanRemoveFromFamily(transactionId, session.user.id);
  if (!ownership.ok) {
    return { success: false, error: ownership.error };
  }

  const { transaction } = ownership;
  // `familyId` has a `@relation` in schema.prisma (the `family` field), so
  // Prisma's generated `TransactionUpdateInput` only exposes it through
  // that relation (`family: { disconnect: true }` — equivalent to setting
  // `familyId: null`, just spelled the relation way). `sharedFamilyId` has
  // no `@relation` counterpart (see its comment in schema.prisma — a plain
  // scalar snapshot, not a live relation), so it's set directly. Both
  // branches also stamp `removedFromFamilyAt: new Date()` — a PERMANENT
  // marker (see its doc comment in schema.prisma) so
  // `buildFamilyTransactionWhere`'s force-share arm
  // (lib/server/actions/family-transactions.ts) never re-includes this row
  // by `userId` alone once it's been deliberately taken out, even though
  // this un-attach leaves it in the exact same `familyId: null` /
  // `sharedFamilyId: null` shape that arm otherwise matches on.
  const data: Prisma.TransactionUpdateInput | null =
    transaction.familyId !== null
      ? { family: { disconnect: true }, removedFromFamilyAt: new Date() }
      : transaction.sharedFamilyId !== null
        ? { sharedFamilyId: null, removedFromFamilyAt: new Date() }
        : // Neither field is set — nothing left to un-attach. REACHABLE in
          // practice (not just a defensive branch): every path where
          // `canDeleteTransaction` lets a caller reach this point for a row
          // already shaped `familyId: null, sharedFamilyId: null` requires
          // `transaction.userId === actorUserId` (see that predicate's
          // "Neither family-attributed nor shared" fallback) — i.e. the
          // caller is always removing their OWN row, and it's already in
          // the target end-state (whether it was always private, or was
          // already removed by a prior call to this same action). Treated
          // as a successful idempotent no-op, NOT `NOT_FOUND_MESSAGE` — the
          // caller asked for "this row not attributed to a family" and
          // that's already true, so failing here would be wrong. See this
          // function's doc comment for the precise idempotency guarantee
          // this provides (and doesn't).
          null;

  if (data === null) {
    return { success: true };
  }

  try {
    await db.transaction.update({
      where: { id: transactionId, deletedAt: null },
      data,
    });
    return { success: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return { success: true };
    }
    throw error;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * Server Action: lists the signed-in user's transactions, most recent
 * first, with pagination.
 *
 * Contract:
 *  - `filters`: `unknown`, not the pre-typed filter shape it conceptually
 *    represents — Server Actions are reachable as plain network endpoints,
 *    so the TS param type on the client is not a runtime guarantee.
 *    Validated here with `transactionFiltersSchema`
 *    ({ from?, to?, categoryId?, type?, page? }, all optional; `page`
 *    defaults to 1). An invalid shape (e.g. `from` after `to`) returns
 *    `{ success: false }` with a generic filter error.
 *  - Always scoped to `where: { userId: session.user.id, ... }` — never
 *    trusts a `userId` from `filters` (there isn't one to trust; this
 *    param intentionally has no such field).
 *  - Pagination: fixed page size of 20 (`DEFAULT_PAGE_SIZE`), via
 *    `take`/`skip`. Returns `total`/`totalPages` alongside `items` so the
 *    caller can render pager UI without a second round-trip.
 *  - `db.transaction.findMany` is a top-level call on `Transaction` — the
 *    soft-delete extension (lib/server/db.ts) auto-filters `deletedAt:
 *    null` here, no manual filter needed. `include: { category: true }` is
 *    safe for the same reason (Transaction is top-level), and intentionally
 *    is NOT soft-delete-filtered on the nested category (see db.ts).
 *  - Output: `ListTransactionsResult`.
 */
/** Shared `where` builder for `listTransactions` and `summarizeTransactions`
 * — always scoped to `userId`, never a `userId` from `filters` (there isn't
 * one; both callers derive it from the session). */
function buildTransactionWhere(
  userId: string,
  filters: { from?: Date; to?: Date; categoryId?: string; type?: TransactionType }
): Prisma.TransactionWhereInput {
  const { from, to, categoryId, type } = filters;
  return {
    userId,
    ...(categoryId ? { categoryId } : {}),
    ...(type ? { type } : {}),
    ...(from || to
      ? {
          date: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
  };
}

export async function listTransactions(filters: unknown = {}): Promise<ListTransactionsResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    return { success: false, error: FILTER_ERROR_MESSAGE };
  }

  const { from, to, categoryId, type, page } = parsed.data;
  const where = buildTransactionWhere(session.user.id, { from, to, categoryId, type });

  const skip = (page - 1) * DEFAULT_PAGE_SIZE;

  const [items, total] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: { date: "desc" },
      include: { category: true },
      take: DEFAULT_PAGE_SIZE,
      skip,
    }),
    db.transaction.count({ where }),
  ]);

  return {
    success: true,
    data: {
      items: items.map(serializeTransaction),
      page,
      pageSize: DEFAULT_PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE)),
    },
  };
}

/**
 * Server Action: totals (income/expense/net) for the signed-in user's
 * transactions matching `filters` — across ALL matching rows, not just one
 * page. Exists because `listTransactions` is paginated (20/page) and the
 * pie chart's per-panel total (`CategoryPieChart`) is only ever computed
 * from the currently-loaded page, which under-reports for any range with
 * more than 20 transactions (a full year, easily). `page` in `filters` is
 * accepted but ignored — this always covers the whole matching set.
 *
 * Sums at the DATABASE level (`groupBy` + `_sum`), not by fetching every
 * row into Node — scales to however many transactions a year holds without
 * pulling full rows over the wire. `groupBy` is a top-level call on
 * `Transaction`, so the soft-delete extension (lib/server/db.ts) still
 * auto-filters `deletedAt: null` here, same as every other read in this file.
 *
 * Output: `TransactionSummaryResult` — `data` is a `PerCurrencySummaryData[]`
 * (one entry per currency present, TRY always first even if zero; see
 * `summarize`'s doc comment in lib/domain/transactions/aggregate.ts). Amounts
 * are returned as `string` (`Decimal.toString()`), not a `Decimal` instance
 * or `number` — Server Actions can't serialize a `Decimal` class instance to
 * the client as-is.
 */
export async function summarizeTransactions(filters: unknown = {}): Promise<TransactionSummaryResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    return { success: false, error: FILTER_ERROR_MESSAGE };
  }

  const { from, to, categoryId, type, baseCurrency } = parsed.data;
  const where = buildTransactionWhere(session.user.id, { from, to, categoryId, type });

  // Grouped by (type, currency), NOT just type — summing a TRY total and a
  // USD total together at the DB level would reintroduce the exact bug this
  // feature fixes, just one level earlier. `summarize` below then folds
  // these rows into one `PerCurrencyTotal` per currency.
  const groups = await db.transaction.groupBy({
    by: ["type", "currency"],
    where,
    _sum: { amount: true },
  });

  const records = groups
    .filter((group) => group._sum.amount !== null)
    .map((group) => ({
      type: group.type,
      currency: group.currency,
      amount: group._sum.amount!.toString(),
    }));
  // `baseCurrency` (see `transactionFiltersSchema`'s doc comment) is
  // caller-supplied — typically the signed-in user's own
  // `preferredCurrency` (`getMyPreferredCurrency()`), defaulting to `"TRY"`
  // when the caller hasn't resolved one.
  const perCurrency = summarize(records, baseCurrency ?? "TRY");

  return {
    success: true,
    data: perCurrency.map((entry) => ({
      currency: entry.currency,
      totalIncome: entry.totalIncome.toString(),
      totalExpense: entry.totalExpense.toString(),
      net: entry.net.toString(),
    })),
  };
}

/**
 * Server Action: ALL of the signed-in user's transactions matching
 * `filters` (not paginated) — for Excel/PDF export. `page` in `filters` is
 * accepted but ignored, same as `summarizeTransactions`. Ordered oldest
 * first (ascending by date), unlike `listTransactions`' newest-first —
 * a chronological read is what a downloaded report/spreadsheet is for,
 * where the in-app list is for finding a specific recent entry.
 *
 * Capped at `EXPORT_ROW_CAP` rows as a sanity ceiling (see that constant's
 * comment) — if a filter genuinely matches more, the export still succeeds
 * with the oldest `EXPORT_ROW_CAP` rows rather than failing outright, since
 * a truncated-but-usable export beats none; `truncated: true` on the
 * result lets the caller warn the user rather than silently under-report.
 */
export async function exportTransactions(filters: unknown = {}): Promise<TransactionExportResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    return { success: false, error: FILTER_ERROR_MESSAGE };
  }

  const { from, to, categoryId, type } = parsed.data;
  const where = buildTransactionWhere(session.user.id, { from, to, categoryId, type });

  const items = await db.transaction.findMany({
    where,
    orderBy: { date: "asc" },
    include: { category: true },
    take: EXPORT_ROW_CAP + 1,
  });

  const truncated = items.length > EXPORT_ROW_CAP;
  const capped = truncated ? items.slice(0, EXPORT_ROW_CAP) : items;
  return { success: true, data: capped.map(serializeTransaction), truncated };
}

export type EarliestTransactionDateResult =
  | { success: true; data: { date: string | null } }
  | { success: false; error: string };

/**
 * Server Action: the date of the signed-in user's earliest transaction
 * matching `filters` — for `TrendView`'s "Yıllık" preset, which needs to
 * know how far back to start a per-year chart (the year the user's data
 * actually begins), not a fixed offset like every other preset. `from`/`to`
 * in `filters` are accepted (reuses `transactionFiltersSchema`) but
 * meaningless here and ignored — a bound would defeat the point of finding
 * the TRUE earliest date; only `type`/`categoryId` matter.
 *
 * Uses `aggregate`'s `_min`, not `findFirst` + `orderBy` — a single
 * DB-side scalar, no row fetched over the wire. `aggregate` is a top-level
 * call on `Transaction`, so the soft-delete extension (lib/server/db.ts)
 * still auto-filters `deletedAt: null` here, same as every other read in
 * this file.
 */
export async function earliestTransactionDate(
  filters: unknown = {}
): Promise<EarliestTransactionDateResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    return { success: false, error: FILTER_ERROR_MESSAGE };
  }

  const { categoryId, type } = parsed.data;
  const where = buildTransactionWhere(session.user.id, { categoryId, type });

  const result = await db.transaction.aggregate({ where, _min: { date: true } });

  return {
    success: true,
    data: { date: result._min.date ? result._min.date.toISOString().slice(0, 10) : null },
  };
}
