"use server";

import Decimal from "decimal.js";
import type { TransactionType, Prisma } from "@prisma/client";

import { db } from "@/lib/server/db";
import { auth } from "@/lib/server/auth";
import { summarize, groupByActor, type PerCurrencyTotal } from "@/lib/domain/transactions";
import { serializeTransaction, type SerializedTransaction } from "@/lib/server/serializers/transaction";
import { familyIdSchema } from "@/lib/validation/family";
import { transactionFiltersSchema } from "@/lib/validation/transaction";
import type {
  PerCurrencySummaryData,
  TransactionSummaryResult,
  EarliestTransactionDateResult,
} from "@/lib/server/actions/transactions";

// Aşama 3.5 — family-scope READ/aggregation actions. Deliberately a
// SEPARATE file from lib/server/actions/transactions.ts rather than adding
// `familyId`-branching reads there: every action here requires `familyId` (no
// individual-scope fallback), so keeping them apart means the `userId`-scoped
// reads in transactions.ts (`listTransactions`/`summarizeTransactions`/
// `exportTransactions`) stay exactly as narrow as the roadmap decided
// (`/transactions` stays individual) without this file's family-membership
// checks creeping into that one, or vice versa.
//
// Every action below follows the same three-step shape:
//   1. auth() — must be signed in.
//   2. validate `familyId` (cuid shape) — then confirm the caller is
//      ACTUALLY a member of that family via a direct, top-level
//      `db.familyMember.findUnique` call (never a nested include on
//      `User`/`Family` — CLAUDE.md). A bad shape, a nonexistent family, and
//      a real family the caller isn't a member of all return the SAME
//      generic `FAMILY_NOT_FOUND_MESSAGE` — this file never confirms or
//      denies that a given `familyId` exists to a non-member, matching
//      `assertOwnsTransaction`'s "don't leak existence vs. authorization"
//      discipline in transactions.ts.
//   3. validate `filters` with the existing `transactionFiltersSchema`.
//   4. resolve the family's current sharing configuration
//      (`getFamilySharingWindow` — the owner's `forceShareIndividualTransactions`
//      kill switch plus the current member roster) and thread it into
//      `buildFamilyTransactionWhere`, which every action's `where` clause is
//      built from.
//
// `db.transaction.*` / `db.familyMember.*` are always DIRECT top-level
// calls here (never reached via `include`/`select` on `User`/`Family`),
// per CLAUDE.md's soft-delete rule. `getFamilySharingWindow`'s nested
// `db.family.findUniqueOrThrow({ select: { members: ... } } })` reaches
// `FamilyMember`, not `Transaction`/`Category`, so it is NOT a soft-delete
// concern either (same reasoning as `getMyFamily` in actions/family.ts).

const UNAUTHENTICATED_MESSAGE = "Bu işlem için giriş yapmanız gerekiyor.";
const FAMILY_NOT_FOUND_MESSAGE = "Aile bulunamadı.";
const FILTER_ERROR_MESSAGE = "Filtreleri kontrol edin.";
const UNKNOWN_MEMBER_NAME = "Eski üye";

const DEFAULT_PAGE_SIZE = 20;
/** Sanity ceiling for exports — mirrors `EXPORT_ROW_CAP` in transactions.ts
 * (not imported from there since that file doesn't export it; keep the
 * VALUE in sync if it ever changes). See that constant's doc comment for why
 * this isn't a product limit. */
const EXPORT_ROW_CAP = 5000;

/**
 * Direct top-level `db.familyMember.*` lookup (never a nested include on
 * `User`/`Family`) for "is `userId` actually a member — any role — of
 * `familyId`?", shared by every action in this file. Returns a generic
 * not-found error rather than a distinct "forbidden" one — see the file
 * banner comment above for why.
 */
async function assertFamilyMembership(
  familyId: string,
  userId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const membership = await db.familyMember.findUnique({
    where: { familyId_userId: { familyId, userId } },
    select: { id: true },
  });
  if (!membership) {
    return { ok: false, error: FAMILY_NOT_FOUND_MESSAGE };
  }
  return { ok: true };
}

/**
 * A family's current sharing configuration, resolved ONCE per action call
 * and threaded into `buildFamilyTransactionWhere` — bundles the owner's
 * kill switch (`Family.forceShareIndividualTransactions`, see
 * `updateForceShareIndividualTransactions` in actions/family.ts) with the
 * CURRENT non-owner member roster's `userId`s, since the switch's read-time
 * widening (below) only ever applies to MEMBERs who belong to the family
 * RIGHT NOW, never to former members (their history is governed exclusively
 * by the `sharedFamilyId` snapshot, same as before this feature existed) and
 * — deliberately — never to the owner themselves: the switch is the owner
 * locking OTHER members' sharing choice away from them (see
 * `updateForceShareIndividualTransactions`'s doc comment), not a way for the
 * owner to accidentally force-expose their OWN personal transactions: the
 * owner's own individual transactions are only ever included via arm 2
 * below (their own `shareIndividualTransactions` toggle,
 * `updateTransactionSharing`), exactly like before this feature existed.
 */
interface FamilySharingWindow {
  forceShareIndividualTransactions: boolean;
  /** CURRENT members with role `MEMBER` only — excludes the owner. */
  memberUserIds: string[];
}

/**
 * Single-query resolver for `FamilySharingWindow` — a direct, top-level
 * `db.family.findUnique` call (NOT `findUniqueOrThrow` — see below). The
 * nested `select: { members: { select: { userId: true, role: true } } } }`
 * here reaches `FamilyMember`, not `Transaction`/`Category`, so it is NOT a
 * CLAUDE.md soft-delete concern (same reasoning as `getMyFamily`'s nested
 * `include` in actions/family.ts). Deliberately a SEPARATE query from the
 * `members`/`ownerName` lookups `listFamilyTransactions`/
 * `familyMemberBreakdown` already do below (those select `userId` +
 * `user.name` for display; this selects `userId` + `role` + the
 * family-level flag) — not merged, since the two serve different shapes and
 * a family's member count is small enough that the extra round-trip is not
 * a real cost.
 *
 * `members` is filtered to `role: "MEMBER"` (excludes `OWNER`) so the
 * force-share arm built from `memberUserIds` never widens to the owner's
 * own personal transactions — see `FamilySharingWindow`'s doc comment.
 *
 * Uses `findUnique` (not `findUniqueOrThrow`) and returns `null` when the
 * family is gone: every caller already validated membership via
 * `assertCallerInFamily` moments earlier, but a family can vanish between
 * that check and this query (e.g. a solo owner's concurrent `leaveFamily()`
 * disbands it, schema.prisma's `Family` disband path in family.ts) — this
 * narrow race is surfaced as the same `FAMILY_NOT_FOUND_MESSAGE` every other
 * "family disappeared out from under you" case in this file uses, instead of
 * an uncaught exception reaching the caller as a generic 500.
 */
async function getFamilySharingWindow(familyId: string): Promise<FamilySharingWindow | null> {
  const family = await db.family.findUnique({
    where: { id: familyId },
    select: {
      forceShareIndividualTransactions: true,
      members: { where: { role: "MEMBER" }, select: { userId: true } },
    },
  });
  if (!family) {
    return null;
  }
  return {
    forceShareIndividualTransactions: family.forceShareIndividualTransactions,
    memberUserIds: family.members.map((member) => member.userId),
  };
}

/**
 * Shared `where` builder for every read in this file — always scoped to
 * `familyId`, never a `userId` from `filters` (there isn't one to trust in
 * `transactionFiltersSchema`, and every action here has already authorized
 * `familyId` via `assertFamilyMembership` before this is called). Mirrors
 * `buildTransactionWhere` in transactions.ts field-for-field, but keyed on
 * `familyId` instead of `userId` — NOT reused from that file, since
 * `buildTransactionWhere` hardcodes `userId` as a required param and mixing
 * the two scopes in one function would risk a caller accidentally getting a
 * `userId`-only (individual-scope) query where a family-wide one was
 * intended, or vice versa.
 *
 * The `OR` has up to three arms:
 *  1. Real family transactions (`familyId` set to this family).
 *  2. PERSONAL transactions (`familyId: null`) that were stamped
 *     `sharedFamilyId: familyId` at creation time — see the `Transaction`
 *     model's doc comment in schema.prisma and `createTransaction`
 *     (lib/server/actions/transactions.ts). This is a permanent,
 *     per-transaction snapshot of the creator's
 *     `FamilyMember.shareIndividualTransactions` preference AT THE MOMENT it
 *     was created — NOT a live re-check of that preference or of current
 *     membership, matching this app's established "leaving/removal doesn't
 *     rewrite history" principle (same as how a former member's real family
 *     transactions keep showing, labeled "Eski üye"; see
 *     `listFamilyTransactions` below). ALWAYS present regardless of
 *     `sharingWindow`, specifically so a former member's past opt-in sharing
 *     keeps showing even after they leave (arm 3 below only ever covers
 *     CURRENT members).
 *  3. Only when `sharingWindow.forceShareIndividualTransactions` is `true`
 *     (the owner's kill switch — `updateForceShareIndividualTransactions` in
 *     actions/family.ts): EVERY current MEMBER's (never the owner's own —
 *     `sharingWindow.memberUserIds` already excludes them, see
 *     `getFamilySharingWindow`) personal (`familyId: null`) transactions, by
 *     `userId`, regardless of their own `shareIndividualTransactions` toggle
 *     value or of what `sharedFamilyId` was stamped at creation time. This is
 *     a pure READ-TIME override — it never rewrites `sharedFamilyId` on any
 *     row, so turning the switch back off just drops this arm again on the
 *     next read, nothing to undo. ALSO requires `removedFromFamilyAt: null`
 *     — a row an OWNER (or, pre-lock, a MEMBER) deliberately took out of the
 *     family view via `removeTransactionFromFamily`
 *     (lib/server/actions/transactions.ts) is left in this exact
 *     `familyId: null` shape by that action, so without this guard it would
 *     silently reappear here the moment the switch is next read as `true` —
 *     defeating the removal. `removedFromFamilyAt` is a PERMANENT marker
 *     (see its doc comment in schema.prisma): there is currently no path
 *     that re-shares a removed row, so nothing currently clears it back to
 *     `null`. Arms 1 and 2 do NOT need this guard: `removeTransactionFromFamily`
 *     clears whichever of `familyId`/`sharedFamilyId` those arms match on, so
 *     a removed row already naturally stops matching either arm on its own.
 *
 * Read-only in every arm: `sharedFamilyId` and the switch both never affect
 * `assertOwnsTransaction` (transactions.ts) — mutation rights stay exactly
 * with the transaction's own `userId`.
 */
function buildFamilyTransactionWhere(
  familyId: string,
  filters: { from?: Date; to?: Date; categoryId?: string; type?: TransactionType },
  sharingWindow: FamilySharingWindow
): Prisma.TransactionWhereInput {
  const { from, to, categoryId, type } = filters;
  const commonFilters: Prisma.TransactionWhereInput = {
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

  return {
    OR: [
      { familyId, ...commonFilters },
      { familyId: null, sharedFamilyId: familyId, ...commonFilters },
      ...(sharingWindow.forceShareIndividualTransactions
        ? [
            {
              familyId: null,
              userId: { in: sharingWindow.memberUserIds },
              removedFromFamilyAt: null,
              ...commonFilters,
            } satisfies Prisma.TransactionWhereInput,
          ]
        : []),
    ],
  };
}

/**
 * Validates `familyId` (shape) then confirms membership (authorization) —
 * the first two steps shared by every action below. Returns the validated
 * `familyId` string on success so callers don't have to re-narrow the
 * `unknown` input themselves.
 */
async function assertCallerInFamily(
  familyId: unknown,
  callerUserId: string
): Promise<{ ok: true; familyId: string } | { ok: false; error: string }> {
  const parsed = familyIdSchema.safeParse(familyId);
  if (!parsed.success) {
    return { ok: false, error: FAMILY_NOT_FOUND_MESSAGE };
  }

  const membership = await assertFamilyMembership(parsed.data, callerUserId);
  if (!membership.ok) {
    return { ok: false, error: membership.error };
  }

  return { ok: true, familyId: parsed.data };
}

// ── listFamilyTransactions ──────────────────────────────────────────────

/**
 * A `SerializedTransaction` plus which family member it belongs to, by
 * display name — added so a family dashboard list can show "who spent this"
 * without a second round-trip per row.
 */
export type FamilyTransactionRow = SerializedTransaction & { ownerName: string };

export type ListFamilyTransactionsResult =
  | {
      success: true;
      data: {
        items: FamilyTransactionRow[];
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
      };
    }
  | { success: false; error: string };

/**
 * Server Action: lists a family's transactions (any member's, not just the
 * caller's), most recent first, with pagination — the family-scope
 * counterpart of `listTransactions` in transactions.ts.
 *
 * Contract (relied on by frontend-developer / mobile-developer):
 *  - `familyId`: `unknown`, conceptually a `Family.id` the caller belongs
 *    to (the frontend already has this from `getMyFamily`). Validated as a
 *    cuid, then the caller's membership in THAT family is verified with a
 *    direct `db.familyMember.findUnique` call — a non-member (including a
 *    member of a *different* family) gets the same generic
 *    `FAMILY_NOT_FOUND_MESSAGE` as a nonexistent id.
 *  - `filters`: same `transactionFiltersSchema` as `listTransactions`
 *    (`{ from?, to?, categoryId?, type?, page? }`, all optional, `page`
 *    defaults to 1).
 *  - Always scoped to `where: { familyId, ... }` — never a `userId`, so
 *    every member's transactions attributed to this family are included,
 *    not just the caller's own.
 *  - Pagination: same fixed page size (`DEFAULT_PAGE_SIZE` = 20) as
 *    `listTransactions`.
 *  - `ownerName`: resolved via a SECOND query
 *    (`db.familyMember.findMany({ where: { familyId } })`, not a per-row
 *    lookup — a single extra round-trip regardless of how many transactions
 *    are on the page) mapping `userId → user.name` for the family's CURRENT
 *    members. A transaction whose `userId` no longer has a `FamilyMember`
 *    row for this family (they left, or were removed by the owner — see
 *    `removeMember`/`leaveFamily` in lib/server/actions/family.ts, which
 *    deliberately leave past transactions' `familyId` untouched) falls back
 *    to a generic `"Eski üye"` label rather than a blank/undefined value.
 *  - `db.transaction.findMany`/`db.familyMember.findMany` are both top-level
 *    calls, so the soft-delete extension (lib/server/db.ts) auto-filters
 *    `deletedAt: null` on the `Transaction` side; `include: { category:
 *    true }` is safe for the same reason (Transaction is top-level here).
 *  - Output: `ListFamilyTransactionsResult`.
 */
export async function listFamilyTransactions(
  familyId: unknown,
  filters: unknown = {}
): Promise<ListFamilyTransactionsResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const familyCheck = await assertCallerInFamily(familyId, session.user.id);
  if (!familyCheck.ok) {
    return { success: false, error: familyCheck.error };
  }

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    return { success: false, error: FILTER_ERROR_MESSAGE };
  }

  const { from, to, categoryId, type, page } = parsed.data;
  const sharingWindow = await getFamilySharingWindow(familyCheck.familyId);
  if (!sharingWindow) {
    // Family was disbanded in the narrow window between `assertCallerInFamily`
    // and this query (e.g. a concurrent solo-owner `leaveFamily()`) — see
    // `getFamilySharingWindow`'s doc comment.
    return { success: false, error: FAMILY_NOT_FOUND_MESSAGE };
  }
  const where = buildFamilyTransactionWhere(familyCheck.familyId, { from, to, categoryId, type }, sharingWindow);
  const skip = (page - 1) * DEFAULT_PAGE_SIZE;

  const [items, total, members] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: { date: "desc" },
      include: { category: true },
      take: DEFAULT_PAGE_SIZE,
      skip,
    }),
    db.transaction.count({ where }),
    db.familyMember.findMany({
      where: { familyId: familyCheck.familyId },
      include: { user: { select: { name: true } } },
    }),
  ]);

  const ownerNameByUserId = new Map(members.map((member) => [member.userId, member.user.name]));

  const rows: FamilyTransactionRow[] = items.map((item) => ({
    ...serializeTransaction(item),
    ownerName: ownerNameByUserId.get(item.userId) ?? UNKNOWN_MEMBER_NAME,
  }));

  return {
    success: true,
    data: {
      items: rows,
      page,
      pageSize: DEFAULT_PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE)),
    },
  };
}

// ── summarizeFamilyTransactions ─────────────────────────────────────────

/**
 * Server Action: totals (income/expense/net) across ALL of a family's
 * transactions matching `filters` — the family-scope counterpart of
 * `summarizeTransactions` in transactions.ts. Same "not just the current
 * page" reasoning: `listFamilyTransactions` is paginated (20/page), a pie
 * chart or headline total needs the whole matching set summed at the
 * DATABASE level (`groupBy` + `_sum`), not by fetching every row into Node.
 *
 * Contract: identical shape to `summarizeTransactions` (reuses
 * `TransactionSummaryResult`/`PerCurrencySummaryData` from transactions.ts —
 * `data` is a per-currency array, TRY always present, never converted across
 * currencies), scoped to `familyId` instead of `userId`. `page` in `filters`
 * is accepted but ignored, same as the individual-scope version. Auth/
 * authorization same as `listFamilyTransactions` above.
 */
export async function summarizeFamilyTransactions(
  familyId: unknown,
  filters: unknown = {}
): Promise<TransactionSummaryResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const familyCheck = await assertCallerInFamily(familyId, session.user.id);
  if (!familyCheck.ok) {
    return { success: false, error: familyCheck.error };
  }

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    return { success: false, error: FILTER_ERROR_MESSAGE };
  }

  const { from, to, categoryId, type, baseCurrency } = parsed.data;
  const sharingWindow = await getFamilySharingWindow(familyCheck.familyId);
  if (!sharingWindow) {
    // Family was disbanded in the narrow window between `assertCallerInFamily`
    // and this query (e.g. a concurrent solo-owner `leaveFamily()`) — see
    // `getFamilySharingWindow`'s doc comment.
    return { success: false, error: FAMILY_NOT_FOUND_MESSAGE };
  }
  const where = buildFamilyTransactionWhere(familyCheck.familyId, { from, to, categoryId, type }, sharingWindow);

  // Grouped by (type, currency) — same "don't sum different currencies
  // together" fix as `summarizeTransactions` (transactions.ts).
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
  // `baseCurrency` — the VIEWER's own preferred currency (whoever is
  // signed in looking at this family dashboard), same "caller-supplied
  // display order" contract as `summarizeTransactions`.
  const perCurrency = summarize(records, baseCurrency ?? "TRY");

  const data: PerCurrencySummaryData[] = perCurrency.map((entry) => ({
    currency: entry.currency,
    totalIncome: entry.totalIncome.toString(),
    totalExpense: entry.totalExpense.toString(),
    net: entry.net.toString(),
  }));

  return { success: true, data };
}

// ── familyMemberBreakdown ───────────────────────────────────────────────

/**
 * One row of `familyMemberBreakdown`'s result — a single member's totals for
 * the matched filter range, PER CURRENCY (see `PerCurrencySummaryData`,
 * transactions.ts) — same "don't sum different currencies together" fix as
 * `summarize`/`summarizeFamilyTransactions`; `totals` is never empty (a
 * `"TRY"` entry is always present, even `"0"`), other currencies only when
 * this member actually used them.
 */
export interface FamilyMemberBreakdownRow {
  userId: string;
  userName: string;
  totals: PerCurrencySummaryData[];
}

export type FamilyMemberBreakdownResult =
  | { success: true; data: FamilyMemberBreakdownRow[] }
  | { success: false; error: string };

/**
 * Server Action (Aşama 3.5, new): per-member income/expense/net totals for
 * a family — "who earned/spent how much" — matching `filters`, PER CURRENCY
 * (see `FamilyMemberBreakdownRow`'s doc comment). Sums at the DATABASE level
 * (`groupBy(by: ["userId", "type", "currency"])` + `_sum`), then folds the
 * resulting (userId × type × currency) rows down to one per-currency
 * breakdown per member with `groupByActor`
 * (lib/domain/transactions/aggregate.ts, pure/unit-testable).
 *
 * Contract:
 *  - Auth + authorization: identical to `listFamilyTransactions` above.
 *  - `filters`: same `transactionFiltersSchema` as every other read here;
 *    `page` is accepted but ignored (this always covers the whole matching
 *    set, same as `summarizeFamilyTransactions`).
 *  - Rows: one per userId that has EITHER a current `FamilyMember` row for
 *    this family OR at least one matching transaction (a former member with
 *    historical family transactions — see `removeMember`/`leaveFamily` in
 *    family.ts, which never touch past transactions — still contributes to
 *    the family's totals and gets a row here, labeled `"Eski üye"` same as
 *    `listFamilyTransactions`' `ownerName` fallback). A CURRENT member with
 *    zero matching transactions still gets a row, with `"0"` totals — so the
 *    UI can render every member even before they've logged anything.
 *  - Ordering: ALL rows (current members and former members alike) sorted by
 *    TRY `totalExpense` descending — biggest (TRY) spender first, smallest
 *    last, mirrors `categoryBreakdown`'s "largest slice first" convention in
 *    lib/domain/transactions/aggregate.ts. Computed from whatever `filters`
 *    scoped `where` to (or the family's whole history if no filter is
 *    active) — same totals the cards display, just also driving their
 *    order, so "highest spender in the selected range is always first" holds
 *    with or without an active filter. Replaced the previous "current
 *    members by `joinedAt`, former members appended after" split (2026-08-22
 *    product decision — the roadmap's `joinedAt` convention makes sense for
 *    `getMyFamily`'s member list but not for a spending comparison).
 *    NOTE (multi-currency, flagged for product/frontend review, not spelled
 *    out in the approved "Çoklu Para Birimi" plan): sorting always compares
 *    the TRY entry specifically (always present in `totals`, per-currency
 *    totals are never converted into one another elsewhere in this feature)
 *    — a member who only ever logs USD/EUR sorts as if they spent "0" here,
 *    even though `totals` correctly shows their real non-TRY figures. This
 *    mirrors the plan's own "no conversion for total rows" rule (decision
 *    #4) rather than inventing a converted ranking metric; call out if
 *    product wants a converted-for-ranking-only alternative instead.
 */
export async function familyMemberBreakdown(
  familyId: unknown,
  filters: unknown = {}
): Promise<FamilyMemberBreakdownResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const familyCheck = await assertCallerInFamily(familyId, session.user.id);
  if (!familyCheck.ok) {
    return { success: false, error: familyCheck.error };
  }

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    return { success: false, error: FILTER_ERROR_MESSAGE };
  }

  const { from, to, categoryId, type } = parsed.data;
  const sharingWindow = await getFamilySharingWindow(familyCheck.familyId);
  if (!sharingWindow) {
    // Family was disbanded in the narrow window between `assertCallerInFamily`
    // and this query (e.g. a concurrent solo-owner `leaveFamily()`) — see
    // `getFamilySharingWindow`'s doc comment.
    return { success: false, error: FAMILY_NOT_FOUND_MESSAGE };
  }
  const where = buildFamilyTransactionWhere(familyCheck.familyId, { from, to, categoryId, type }, sharingWindow);

  const [groups, members] = await Promise.all([
    db.transaction.groupBy({
      by: ["userId", "type", "currency"],
      where,
      _sum: { amount: true },
    }),
    db.familyMember.findMany({
      where: { familyId: familyCheck.familyId },
      include: { user: { select: { name: true } } },
      orderBy: { joinedAt: "asc" },
    }),
  ]);

  const records = groups
    .filter((group) => group._sum.amount !== null)
    .map((group) => ({
      userId: group.userId,
      type: group.type,
      currency: group.currency,
      amount: group._sum.amount!.toString(),
    }));
  const totalsByUserId = groupByActor(records);

  /** `"TRY": "0"` only — matches `summarize`'s own "TRY always present"
   * zero-fill rule for a member with no matching transactions at all (never
   * even reached `groupByActor`, so there's no `PerCurrencyTotal[]` to
   * serialize for them). */
  const zeroTotals: PerCurrencySummaryData[] = [
    { currency: "TRY", totalIncome: "0", totalExpense: "0", net: "0" },
  ];

  function toSummaryData(perCurrency: PerCurrencyTotal[] | undefined): PerCurrencySummaryData[] {
    if (!perCurrency) return zeroTotals;
    return perCurrency.map((entry) => ({
      currency: entry.currency,
      totalIncome: entry.totalIncome.toString(),
      totalExpense: entry.totalExpense.toString(),
      net: entry.net.toString(),
    }));
  }

  /** The TRY entry's `totalExpense` — always present in `totals` (see
   * `toSummaryData`/`zeroTotals` above) — used purely to ORDER rows; see the
   * multi-currency note on this function's doc comment above for why TRY
   * specifically. */
  function tryExpense(totals: PerCurrencySummaryData[]): Decimal {
    return new Decimal(totals.find((entry) => entry.currency === "TRY")?.totalExpense ?? "0");
  }

  const currentMemberRows: FamilyMemberBreakdownRow[] = members.map((member) => ({
    userId: member.userId,
    userName: member.user.name,
    totals: toSummaryData(totalsByUserId.get(member.userId)),
  }));

  const currentMemberUserIds = new Set(members.map((member) => member.userId));
  const formerMemberRows: FamilyMemberBreakdownRow[] = Array.from(totalsByUserId.entries())
    .filter(([userId]) => !currentMemberUserIds.has(userId))
    .map(([userId, perCurrency]) => ({
      userId,
      userName: UNKNOWN_MEMBER_NAME,
      totals: toSummaryData(perCurrency),
    }));

  // Highest (TRY) spender first, lowest last — across ALL rows together
  // (current and former members combined, not sorted within separate
  // groups), and regardless of whether `filters` narrowed the range: `where`
  // above already scopes `groups` to whatever's selected (or the family's
  // whole history with no filter), so this just orders the resulting
  // totals. `Decimal` comparison (not `Number(...)`) avoids float-precision
  // edge cases on large amounts.
  const sortedRows = [...currentMemberRows, ...formerMemberRows].sort((a, b) =>
    tryExpense(b.totals).comparedTo(tryExpense(a.totals))
  );

  return { success: true, data: sortedRows };
}

// ── earliestFamilyTransactionDate ───────────────────────────────────────

/**
 * Server Action: the date of a family's earliest transaction matching
 * `filters` — the family-scope counterpart of `earliestTransactionDate` in
 * transactions.ts, for the same "Yıllık" trend-preset use case but across
 * the whole family rather than just the caller.
 *
 * Contract: identical shape to `earliestTransactionDate` (reuses
 * `EarliestTransactionDateResult` from transactions.ts). `from`/`to` in
 * `filters` are accepted but meaningless here and ignored (same as the
 * individual-scope version) — only `type`/`categoryId` matter. Auth/
 * authorization same as `listFamilyTransactions` above. Uses `aggregate`'s
 * `_min`, a single DB-side scalar, not a fetched row.
 */
export async function earliestFamilyTransactionDate(
  familyId: unknown,
  filters: unknown = {}
): Promise<EarliestTransactionDateResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const familyCheck = await assertCallerInFamily(familyId, session.user.id);
  if (!familyCheck.ok) {
    return { success: false, error: familyCheck.error };
  }

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    return { success: false, error: FILTER_ERROR_MESSAGE };
  }

  const { categoryId, type } = parsed.data;
  const sharingWindow = await getFamilySharingWindow(familyCheck.familyId);
  if (!sharingWindow) {
    // Family was disbanded in the narrow window between `assertCallerInFamily`
    // and this query (e.g. a concurrent solo-owner `leaveFamily()`) — see
    // `getFamilySharingWindow`'s doc comment.
    return { success: false, error: FAMILY_NOT_FOUND_MESSAGE };
  }
  const where = buildFamilyTransactionWhere(familyCheck.familyId, { categoryId, type }, sharingWindow);

  const result = await db.transaction.aggregate({ where, _min: { date: true } });

  return {
    success: true,
    data: { date: result._min.date ? result._min.date.toISOString().slice(0, 10) : null },
  };
}

// ── exportFamilyTransactions ────────────────────────────────────────────

/** Same shape as `TransactionExportResult` (transactions.ts) but with
 * `ownerName` on each row — added 2026-08-22 for `FamilyTrendView`'s
 * per-member drill-down panel, which needs to know WHO each exported row
 * belongs to (same `ownerName` resolution `listFamilyTransactions` already
 * does), not just the totals. `FamilyTransactionRow[]` is a structural
 * superset of `SerializedTransaction[]`/`TransactionViewModel[]`, so this
 * stays a drop-in for every EXISTING caller (`CategoryPieChart`'s
 * `categoryBreakdown()` input, `ExportButtons`' Excel/PDF rows) — neither
 * reads `ownerName`, they just get it along for the ride. */
export type FamilyTransactionExportResult =
  | { success: true; data: FamilyTransactionRow[]; truncated?: boolean }
  | { success: false; error: string };

/**
 * Server Action: ALL of a family's transactions matching `filters` (not
 * paginated) — the family-scope counterpart of `exportTransactions` in
 * transactions.ts. Same use case as that one — a `CategoryPieChart` (or an
 * Excel/PDF export) needs every matching row's `category`/`amount`/`type`
 * to compute its own client-side `categoryBreakdown()` breakdown, which
 * `listFamilyTransactions`' paginated (20/page) result can't provide for
 * any range with more than 20 transactions. `page` in `filters` is accepted
 * but ignored, same as `summarizeFamilyTransactions`. Ordered oldest first
 * (ascending by date), matching `exportTransactions`' convention.
 *
 * Capped at `EXPORT_ROW_CAP` rows as a sanity ceiling (same value as
 * transactions.ts' `EXPORT_ROW_CAP`) — if a filter genuinely matches more,
 * the export still succeeds with the oldest `EXPORT_ROW_CAP` rows rather
 * than failing outright; `truncated: true` on the result lets the caller
 * warn the user rather than silently under-report.
 *
 * Contract: same shape as `exportTransactions`, PLUS `ownerName` per row
 * (`FamilyTransactionExportResult`, not the plain `TransactionExportResult`
 * `exportTransactions` returns) — resolved the SAME way
 * `listFamilyTransactions` does (a second `db.familyMember.findMany` query,
 * `userId → user.name`, falling back to `UNKNOWN_MEMBER_NAME` for a former
 * member). Scoped to `familyId` (via `buildFamilyTransactionWhere`, which
 * also folds in personal transactions shared with this family via
 * `sharedFamilyId`) instead of `userId`. Auth/authorization same as
 * `listFamilyTransactions` above.
 */
export async function exportFamilyTransactions(
  familyId: unknown,
  filters: unknown = {}
): Promise<FamilyTransactionExportResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const familyCheck = await assertCallerInFamily(familyId, session.user.id);
  if (!familyCheck.ok) {
    return { success: false, error: familyCheck.error };
  }

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) {
    return { success: false, error: FILTER_ERROR_MESSAGE };
  }

  const { from, to, categoryId, type } = parsed.data;
  const sharingWindow = await getFamilySharingWindow(familyCheck.familyId);
  if (!sharingWindow) {
    // Family was disbanded in the narrow window between `assertCallerInFamily`
    // and this query (e.g. a concurrent solo-owner `leaveFamily()`) — see
    // `getFamilySharingWindow`'s doc comment.
    return { success: false, error: FAMILY_NOT_FOUND_MESSAGE };
  }
  const where = buildFamilyTransactionWhere(familyCheck.familyId, { from, to, categoryId, type }, sharingWindow);

  const [items, members] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: { date: "asc" },
      include: { category: true },
      take: EXPORT_ROW_CAP + 1,
    }),
    db.familyMember.findMany({
      where: { familyId: familyCheck.familyId },
      include: { user: { select: { name: true } } },
    }),
  ]);

  const ownerNameByUserId = new Map(members.map((member) => [member.userId, member.user.name]));
  const truncated = items.length > EXPORT_ROW_CAP;
  const capped = truncated ? items.slice(0, EXPORT_ROW_CAP) : items;
  const rows: FamilyTransactionRow[] = capped.map((item) => ({
    ...serializeTransaction(item),
    ownerName: ownerNameByUserId.get(item.userId) ?? UNKNOWN_MEMBER_NAME,
  }));
  return { success: true, data: rows, truncated };
}
