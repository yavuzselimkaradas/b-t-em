"use server";

import { Prisma } from "@prisma/client";
import type { Category, Currency, BudgetPeriod } from "@prisma/client";

import { db } from "@/lib/server/db";
import { auth } from "@/lib/server/auth";
import { canManageBudget, evaluateBudgetStatus, type BudgetStatus } from "@/lib/domain/budgets";
import {
  budgetSchema,
  budgetUpdateSchema,
  budgetIdSchema,
  type BudgetInput,
} from "@/lib/validation/budget";
import { familyIdSchema } from "@/lib/validation/family";

// Roadmap Aşama 6 (Bütçe Limitleri), approved plan: "Kategori bazlı aylık
// limit + aşım uyarısı ... Sadece owner (veya bireysel kullanıcı) limit
// oluşturabilir; XOR kısıt DB+Zod'da." This file serves BOTH the individual
// scope (`userId`, used by "Bireysel Plan Ayarları") and the family scope
// (`familyId`, used by "Aile Planı Ayarları") from ONE action set, mirroring
// `Budget.userId`/`Budget.familyId`'s XOR shape in schema.prisma — a
// deliberate choice over splitting into two files the way
// transactions.ts/family-transactions.ts are split: THAT split exists
// because the individual-scope reads in transactions.ts never take a
// `familyId` at all (a hard product boundary — `/transactions` stays
// individual-only). Here every action's caller-facing shape is identical
// between scopes (same input/output types) and differs only in which
// `where` clause and which authorization rule apply, so one small,
// consistently-scoped module is more DRY than two near-duplicate files.
//
// Every mutation's authorization entry point is explicit and near the top of
// the function body (qa-engineer: this is what to attack; cyber-security:
// this is what to audit) — see `assertCanManageFamilyBudgets` /
// `assertOwnsBudget` below, both built on the pure, unit-testable
// `canManageBudget` predicate in lib/domain/budgets/evaluate.ts.
//
// `db.familyMember.*` is always a DIRECT top-level call here (never reached
// via `include`/`select` on `User`/`Family`), and `db.transaction.*` /
// `db.category.*` are always direct top-level calls scoped by
// `where: { userId }` / `where: { familyId }` — per CLAUDE.md's soft-delete
// rule (Budget itself carries no `deletedAt` and is not in the soft-delete
// set — every delete here is a real `db.budget.delete`).

// STABLE KEYS (`errors.<camelCase>`), not translated text — this file never
// imports next-intl; the client resolves these via `messages/{locale}.json`'s
// `errors` namespace.
const UNAUTHENTICATED_MESSAGE = "errors.unauthenticated";
const NOT_FOUND_MESSAGE = "errors.budgetNotFound";
const NOT_OWNER_MESSAGE = "errors.familyOwnerOnly";
const FAMILY_NOT_FOUND_MESSAGE = "errors.familyNotFound";
const VALIDATION_ERROR_MESSAGE = "errors.validationFailed";
// Shared with lib/server/actions/transactions.ts's own `NO_FIELDS_MESSAGE`
// (identical source text: "Güncellenecek bir alan girin.") — deduped to one key.
const NO_FIELDS_MESSAGE = "errors.noFieldsToUpdate";
const DUPLICATE_MESSAGE = "errors.budgetDuplicate";
// Shared with lib/server/actions/transactions.ts's own
// `CATEGORY_NOT_FOUND_MESSAGE` (identical source text: "Seçilen kategori
// bulunamadı.") — deduped to one key.
const CATEGORY_NOT_FOUND_MESSAGE = "errors.categoryNotFound";
// Design decision (flagging for software-architect/product review, not in
// the original task spec verbatim): a Budget limit is only meaningful
// against EXPENSE categories — `spentThisMonth` below is computed by summing
// EXPENSE transactions, so attaching a limit to an INCOME category would
// always read "0 / limit" and never warn/exceed. Enforced here the same way
// `assertUsableCategory` enforces type-matching for transactions.ts. Own key
// (not deduped) — different source text from transactions.ts's own
// `errors.transactionCategoryTypeMismatch`.
const CATEGORY_TYPE_MISMATCH_MESSAGE = "errors.budgetCategoryMustBeExpense";

export type BudgetFieldErrors = Partial<Record<keyof BudgetInput, string[]>>;

/**
 * A fully-resolved Budget row as returned to the caller — Decimal fields
 * (`limitAmount`, `spentThisMonth`) as `string`, never a live `Prisma.Decimal`
 * instance (same reasoning as `serializeTransaction` in
 * lib/server/serializers/transaction.ts: a Decimal class instance fails
 * React's "only plain objects can cross the Server Action boundary" check).
 * `category` is nested as-is (`Category` has no Decimal fields, so no
 * further serialization is needed there — same as `listCategories`'
 * `Category[]` return type in categories.ts).
 */
export interface BudgetRow {
  id: string;
  categoryId: string;
  category: Category;
  limitAmount: string;
  currency: Currency;
  period: BudgetPeriod;
  createdAt: Date;
  updatedAt: Date;
  /** Sum of this scope's EXPENSE transactions in `categoryId`, from the 1st
   * of the current calendar month through now. */
  spentThisMonth: string;
  status: BudgetStatus;
  /** `spentThisMonth / limitAmount * 100` — see `evaluateBudgetStatus`
   * (lib/domain/budgets/evaluate.ts) for the exact rule, including the 0
   * fallback when `limitAmount` is somehow 0. */
  percentage: number;
}

export type ListBudgetsResult =
  | { success: true; data: BudgetRow[] }
  | { success: false; error: string };

export type BudgetActionResult =
  | { success: true; data: BudgetRow }
  | { success: false; error: string; fieldErrors?: BudgetFieldErrors };

export type DeleteBudgetResult = { success: true } | { success: false; error: string };

/**
 * The caller-facing scope selector, shared by `listBudgets` and
 * `createBudget` — `"individual"` (the caller's own `userId`) or
 * `{ familyId }` (a family the caller claims to belong to). `familyId` is
 * `unknown`, not a pre-typed `string` — Server Actions are reachable as
 * plain network endpoints, so it is validated (`familyIdSchema`) before use,
 * same discipline as every other Server Action input in this codebase.
 *
 * `updateBudget`/`deleteBudget` deliberately do NOT take a `BudgetScope` —
 * the scope of an EXISTING budget is read back from its own row
 * (`assertOwnsBudget`), never re-asserted by the caller, so a caller can't
 * claim a different scope than the row actually has.
 */
export type BudgetScope = "individual" | { familyId: unknown };

type OwnerWhere = { userId: string } | { familyId: string };

function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/**
 * Direct top-level `db.transaction.aggregate` (soft-delete-filtered by the
 * extension in lib/server/db.ts) summing EXPENSE transactions in
 * `categoryId`, scoped to `ownerWhere`, from `monthStart` through now.
 * Returns a `string` (Decimal.toString()), `"0"` when there are none.
 *
 * `currency` (new): filters to ONLY transactions in the budget's OWN
 * currency — design decision #5 in the approved "Çoklu Para Birimi" plan:
 * "bir bütçenin spentAmount'ı SADECE budget.currency ile aynı para
 * birimindeki işlemlerden hesaplanır (dönüşüm yok — FX'e bağımlı olmasın)".
 * A ₺5000 limit with a $50 expense logged against the same category does
 * NOT count toward that limit; the user would need a separate USD budget
 * for that category to track it. This intentionally does not consult FX
 * rates at all, unlike `categoryBreakdown` — keeps budget evaluation
 * independent of the FX endpoint's availability.
 */
async function spentForCategory(
  ownerWhere: OwnerWhere,
  categoryId: string,
  currency: Currency,
  monthStart: Date
): Promise<string> {
  const result = await db.transaction.aggregate({
    where: { ...ownerWhere, categoryId, currency, type: "EXPENSE", date: { gte: monthStart } },
    _sum: { amount: true },
  });
  return result._sum.amount?.toString() ?? "0";
}

function toBudgetRow(
  budget: Prisma.BudgetGetPayload<{ include: { category: true } }>,
  spentAmount: string
): BudgetRow {
  const { status, percentage } = evaluateBudgetStatus(budget.limitAmount.toString(), spentAmount);
  return {
    id: budget.id,
    categoryId: budget.categoryId,
    category: budget.category,
    limitAmount: budget.limitAmount.toString(),
    currency: budget.currency,
    period: budget.period,
    createdAt: budget.createdAt,
    updatedAt: budget.updatedAt,
    spentThisMonth: spentAmount,
    status,
    percentage,
  };
}

// ── Authorization ────────────────────────────────────────────────────────

/**
 * Validates `familyId` (shape) then confirms the caller is a MEMBER (any
 * role) of that family — for `listBudgets`' family scope, where viewing is
 * allowed for owner AND member alike (only mutation is owner-only). Direct
 * top-level `db.familyMember.findUnique` (never a nested include on
 * `User`/`Family` — CLAUDE.md). A bad shape and a non-member both return the
 * same generic `FAMILY_NOT_FOUND_MESSAGE` — matches
 * `assertCallerInFamily`'s "don't leak existence vs. authorization"
 * discipline in lib/server/actions/family-transactions.ts (this file does
 * not import that one to avoid coupling two independently-evolving action
 * modules over a few lines of query logic — see file banner comment above).
 */
async function assertFamilyMembership(
  familyId: unknown,
  callerUserId: string
): Promise<{ ok: true; familyId: string } | { ok: false; error: string }> {
  const parsed = familyIdSchema.safeParse(familyId);
  if (!parsed.success) {
    return { ok: false, error: FAMILY_NOT_FOUND_MESSAGE };
  }
  const membership = await db.familyMember.findUnique({
    where: { familyId_userId: { familyId: parsed.data, userId: callerUserId } },
    select: { id: true },
  });
  if (!membership) {
    return { ok: false, error: FAMILY_NOT_FOUND_MESSAGE };
  }
  return { ok: true, familyId: parsed.data };
}

/**
 * Validates `familyId` (shape), looks up the caller's role in THAT family,
 * then applies `canManageBudget` (lib/domain/budgets/evaluate.ts) — for
 * `createBudget`'s family scope, where only the OWNER may create a limit
 * (roadmap Aşama 6: "Sadece owner ... limit oluşturabilir"). A bad shape, a
 * non-member, and a member who isn't OWNER all collapse to the same
 * `NOT_OWNER_MESSAGE` — deliberately, mirroring `assertIsFamilyOwner` in
 * lib/server/actions/family.ts ("this endpoint never reveals whether the
 * caller is a plain member vs. has no family, since neither case grants
 * permission").
 */
async function assertCanManageFamilyBudgets(
  familyId: unknown,
  callerUserId: string
): Promise<{ ok: true; familyId: string } | { ok: false; error: string }> {
  const parsed = familyIdSchema.safeParse(familyId);
  if (!parsed.success) {
    return { ok: false, error: NOT_OWNER_MESSAGE };
  }
  const membership = await db.familyMember.findUnique({
    where: { familyId_userId: { familyId: parsed.data, userId: callerUserId } },
    select: { role: true },
  });
  const actorFamilyRole = membership?.role ?? null;
  if (!canManageBudget({ type: "family", actorFamilyRole })) {
    return { ok: false, error: NOT_OWNER_MESSAGE };
  }
  return { ok: true, familyId: parsed.data };
}

/**
 * Fetches a Budget and applies `canManageBudget` for `updateBudget`/
 * `deleteBudget` — the budget-limit counterpart of `assertOwnsTransaction`
 * in lib/server/actions/transactions.ts. Returns a generic "not found"
 * error — not "forbidden" — for "doesn't exist", "is an individual budget
 * belonging to someone else", AND "is a family budget but the caller isn't
 * that family's OWNER", so a budget id can't be used to probe whose it is or
 * which family it belongs to.
 */
async function assertOwnsBudget(
  id: string,
  actorUserId: string
): Promise<
  | { ok: true; budget: { id: string; userId: string | null; familyId: string | null } }
  | { ok: false; error: string }
> {
  const budget = await db.budget.findUnique({
    where: { id },
    select: { id: true, userId: true, familyId: true },
  });
  if (!budget) {
    return { ok: false, error: NOT_FOUND_MESSAGE };
  }

  if (budget.userId !== null) {
    if (budget.userId !== actorUserId) {
      return { ok: false, error: NOT_FOUND_MESSAGE };
    }
    return { ok: true, budget };
  }

  // Family-scoped budget (`budget.familyId` is guaranteed non-null here by
  // the DB-level `budget_owner_xor` CHECK constraint).
  const membership = await db.familyMember.findUnique({
    where: { familyId_userId: { familyId: budget.familyId!, userId: actorUserId } },
    select: { role: true },
  });
  const actorFamilyRole = membership?.role ?? null;
  if (!canManageBudget({ type: "family", actorFamilyRole })) {
    return { ok: false, error: NOT_FOUND_MESSAGE };
  }
  return { ok: true, budget };
}

/**
 * Confirms `categoryId` both exists and is usable for a budget in this
 * scope, and that it is an EXPENSE category (see `CATEGORY_TYPE_MISMATCH_MESSAGE`
 * above). "Usable": the seeded defaults (`isDefault: true`), OR the caller's
 * own personal category (`category.userId === userId`), OR — family scope —
 * a category shared by that same family (`category.familyId === familyId`).
 * Mirrors `assertUsableCategory` in lib/server/actions/transactions.ts
 * field-for-field, not imported from there (that function is private to
 * transactions.ts, and the two modules are kept independently evolvable —
 * see file banner comment above).
 */
async function assertUsableBudgetCategory(
  categoryId: string,
  userId: string,
  familyId: string | null
): Promise<{ ok: true } | { ok: false; error: string; fieldErrors: BudgetFieldErrors }> {
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

  if (category.type !== "EXPENSE") {
    return {
      ok: false,
      error: CATEGORY_TYPE_MISMATCH_MESSAGE,
      fieldErrors: { categoryId: [CATEGORY_TYPE_MISMATCH_MESSAGE] },
    };
  }

  return { ok: true };
}

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * Server Action: lists the budgets for `scope` (the signed-in user's own, or
 * a family's), each enriched with this calendar month's spend and
 * `evaluateBudgetStatus` output.
 *
 * Contract (relied on by frontend-developer / mobile-developer):
 *  - Auth: requires a session; generic message if absent.
 *  - `scope`: `"individual"` → `where: { userId: session.user.id }`.
 *    `{ familyId }` → the caller's MEMBERSHIP (any role) in that family is
 *    verified first (`assertFamilyMembership`) — both owner and member may
 *    VIEW a family's budgets, only OWNER may mutate them (see
 *    `createBudget`/`updateBudget`/`deleteBudget` below).
 *  - `spentThisMonth`/`status`/`percentage`: computed with ONE extra
 *    `db.transaction.groupBy` covering every listed budget's category at
 *    once (not one query per row) — scales to however many category limits
 *    exist without N+1 round-trips, same reasoning as
 *    `familyMemberBreakdown` in family-transactions.ts.
 *  - Ordering: `createdAt` ascending (oldest limit first — stable, matches
 *    the order a user set them up in).
 *  - Output: `ListBudgetsResult`.
 */
export async function listBudgets(scope: BudgetScope): Promise<ListBudgetsResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  let ownerWhere: OwnerWhere;
  if (scope === "individual") {
    ownerWhere = { userId: session.user.id };
  } else {
    const familyCheck = await assertFamilyMembership(scope.familyId, session.user.id);
    if (!familyCheck.ok) {
      return { success: false, error: familyCheck.error };
    }
    ownerWhere = { familyId: familyCheck.familyId };
  }

  const budgets = await db.budget.findMany({
    where: ownerWhere,
    include: { category: true },
    orderBy: { createdAt: "asc" },
  });

  if (budgets.length === 0) {
    return { success: true, data: [] };
  }

  const monthStart = startOfCurrentMonth();
  const categoryIds = budgets.map((budget) => budget.categoryId);

  // Grouped by (categoryId, currency), NOT just categoryId — two budgets can
  // share a category with different currencies (e.g. a TRY "Market" limit
  // and a USD "Market" limit both exist), and `spentForCategory`'s
  // same-currency-only rule (see its doc comment) must hold here too, in
  // this batched form. Keyed with a plain `${categoryId}:${currency}` string
  // (a `Map` can't use a tuple as a key) rather than a nested Map — simpler
  // to build/read for this single lookup.
  const spendGroups = await db.transaction.groupBy({
    by: ["categoryId", "currency"],
    where: { ...ownerWhere, categoryId: { in: categoryIds }, type: "EXPENSE", date: { gte: monthStart } },
    _sum: { amount: true },
  });
  const spentByKey = new Map(
    spendGroups.map((group) => [
      `${group.categoryId}:${group.currency}`,
      group._sum.amount?.toString() ?? "0",
    ])
  );

  const data = budgets.map((budget) =>
    toBudgetRow(budget, spentByKey.get(`${budget.categoryId}:${budget.currency}`) ?? "0")
  );

  return { success: true, data };
}

// ── Mutations ────────────────────────────────────────────────────────────

/**
 * Server Action: creates a Budget (category monthly limit) in `scope`.
 *
 * Contract:
 *  - Auth: requires a session; generic message if absent.
 *  - `scope`: `"individual"` → `Budget.userId = session.user.id`,
 *    `familyId = null`; always allowed (`canManageBudget({type:
 *    "individual"})` is always `true` — the caller is always managing their
 *    OWN individual budgets, there is no "on behalf of someone else" case
 *    for this scope). `{ familyId }` → `assertCanManageFamilyBudgets`: the
 *    caller must be that family's OWNER, or this is rejected with
 *    `NOT_OWNER_MESSAGE` before any input validation runs (a member should
 *    never learn field-level validation details about a mutation they can't
 *    perform at all).
 *  - `input`: `unknown`, validated with `budgetSchema`
 *    (`{ categoryId, limitAmount, currency }`; `period` is never
 *    caller-supplied — always set to `"MONTHLY"` server-side, see that
 *    schema's comment for why).
 *  - `categoryId` must be a usable, EXPENSE-type category for this scope
 *    (`assertUsableBudgetCategory`) — same visibility rules as
 *    `assertUsableCategory` for transactions (defaults + own personal +,
 *    for family scope, that family's shared categories).
 *  - Duplicate limit: `Budget`'s `@@unique([userId, familyId, categoryId,
 *    period])` (schema.prisma) is the actual guard; a `P2002` here is caught
 *    and translated into a friendly, field-scoped `DUPLICATE_MESSAGE`
 *    ("... düzenleyebilirsiniz.") rather than a raw constraint-violation
 *    error — same pattern as `createFamily`'s `P2002` handling.
 *  - `userId`/`familyId` are ALWAYS derived from the session/validated scope,
 *    never from `input` (there isn't a field for either in `BudgetInput` —
 *    nothing to even trust here).
 *  - Output: `BudgetActionResult`. On success, `data` includes this month's
 *    spend/status/percentage (freshly computed, not just zeros) so the
 *    caller can render the new row immediately without a follow-up
 *    `listBudgets` call.
 */
export async function createBudget(input: unknown, scope: BudgetScope): Promise<BudgetActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  let ownerWhere: OwnerWhere;
  let ownerData: { userId: string | null; familyId: string | null };
  if (scope === "individual") {
    ownerWhere = { userId: session.user.id };
    ownerData = { userId: session.user.id, familyId: null };
  } else {
    const familyCheck = await assertCanManageFamilyBudgets(scope.familyId, session.user.id);
    if (!familyCheck.ok) {
      return { success: false, error: familyCheck.error };
    }
    ownerWhere = { familyId: familyCheck.familyId };
    ownerData = { userId: null, familyId: familyCheck.familyId };
  }

  const parsed = budgetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as BudgetFieldErrors,
    };
  }
  const { categoryId, limitAmount, currency } = parsed.data;

  const categoryCheck = await assertUsableBudgetCategory(categoryId, session.user.id, ownerData.familyId);
  if (!categoryCheck.ok) {
    return { success: false, error: categoryCheck.error, fieldErrors: categoryCheck.fieldErrors };
  }

  try {
    const budget = await db.budget.create({
      data: {
        userId: ownerData.userId,
        familyId: ownerData.familyId,
        categoryId,
        limitAmount,
        currency,
        period: "MONTHLY",
      },
      include: { category: true },
    });

    const spentAmount = await spentForCategory(ownerWhere, categoryId, currency, startOfCurrentMonth());
    return { success: true, data: toBudgetRow(budget, spentAmount) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: DUPLICATE_MESSAGE, fieldErrors: { categoryId: [DUPLICATE_MESSAGE] } };
    }
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
 * Server Action: updates an EXISTING Budget's `limitAmount`/`currency`.
 *
 * Contract:
 *  - `id`: `unknown`, validated as a cuid (`budgetIdSchema`); any other
 *    shape is treated the same as "not found".
 *  - Auth + authorization: requires a session AND `canManageBudget` (via
 *    `assertOwnsBudget`) to return true for the existing row — for an
 *    individual budget, only its own `userId` may update it; for a family
 *    budget, only that family's OWNER may, regardless of who originally
 *    created it. A non-authorized caller or a non-existent id both return
 *    the same generic `NOT_FOUND_MESSAGE`.
 *  - `input`: a PARTIAL `BudgetInput` minus `categoryId`
 *    (`budgetUpdateSchema`) — re-attributing an existing limit to a
 *    different category is not supported via update, same "fixed at
 *    creation" discipline `transactionUpdateSchema` uses for `familyId`.
 *    Sending an empty object returns `NO_FIELDS_MESSAGE`.
 *  - Output: `BudgetActionResult`, same shape as `createBudget`, with
 *    freshly recomputed `spentThisMonth`/`status`/`percentage`.
 */
export async function updateBudget(id: unknown, input: unknown): Promise<BudgetActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const idResult = budgetIdSchema.safeParse(id);
  if (!idResult.success) {
    return { success: false, error: NOT_FOUND_MESSAGE };
  }
  const budgetId = idResult.data;

  // Ownership/authorization check BEFORE validating `input`'s body — same
  // "don't do extra work for a request that's going to be rejected anyway,
  // and don't leak field-level detail to an unauthorized caller" reasoning
  // as `updateTransaction`.
  const ownership = await assertOwnsBudget(budgetId, session.user.id);
  if (!ownership.ok) {
    return { success: false, error: ownership.error };
  }

  const parsed = budgetUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as BudgetFieldErrors,
    };
  }

  if (Object.keys(parsed.data).length === 0) {
    return { success: false, error: NO_FIELDS_MESSAGE };
  }

  try {
    const budget = await db.budget.update({
      where: { id: budgetId },
      data: parsed.data,
      include: { category: true },
    });

    const ownerWhere: OwnerWhere =
      ownership.budget.userId !== null
        ? { userId: ownership.budget.userId }
        : { familyId: ownership.budget.familyId! };
    // `budget.currency` — the FRESHLY UPDATED row's currency, not
    // `ownership.budget`'s (which was fetched before this update and never
    // selected `currency` anyway) — correct even when this very update just
    // changed `currency` itself.
    const spentAmount = await spentForCategory(
      ownerWhere,
      budget.categoryId,
      budget.currency,
      startOfCurrentMonth()
    );

    return { success: true, data: toBudgetRow(budget, spentAmount) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      // Row vanished (concurrent delete) between the ownership check above
      // and this update.
      return { success: false, error: NOT_FOUND_MESSAGE };
    }
    throw error;
  }
}

/**
 * Server Action: hard-deletes a Budget the signed-in caller is authorized to
 * manage. `Budget` has no `deletedAt` column and is not in CLAUDE.md's
 * soft-delete set (only `Transaction`/`Category` are), so a real
 * `db.budget.delete(...)` is correct here.
 *
 * Contract:
 *  - `id`/auth/authorization: identical rules to `updateBudget` above
 *    (`assertOwnsBudget` — individual: own `userId` only; family: OWNER
 *    only).
 *  - Idempotent: deleting an already-deleted (or already-gone) id returns
 *    `{ success: true }`, not an error — same "double click must not
 *    surface as a failure" contract as `softDeleteTransaction`/
 *    `revokeInvite`/`removeMember`.
 *  - Output: `DeleteBudgetResult`. No `data` payload on success.
 */
export async function deleteBudget(id: unknown): Promise<DeleteBudgetResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const idResult = budgetIdSchema.safeParse(id);
  if (!idResult.success) {
    return { success: false, error: NOT_FOUND_MESSAGE };
  }
  const budgetId = idResult.data;

  const ownership = await assertOwnsBudget(budgetId, session.user.id);
  if (!ownership.ok) {
    return { success: false, error: ownership.error };
  }

  try {
    await db.budget.delete({ where: { id: budgetId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return { success: true };
    }
    throw error;
  }

  return { success: true };
}
