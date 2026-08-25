// Shared shape the transaction UI (TransactionsView / TransactionForm /
// DeleteTransactionDialog) reads, regardless of whether the data came from
// the server (Server Actions, signed-in users) or from
// lib/client/guest-store.ts (localStorage, guest mode — see CLAUDE.md
// "Misafir modu"). Both concrete sources' item types
// (`TransactionWithCategory` in lib/server/actions/transactions.ts and
// `GuestTransactionWithCategory` in guest-store.ts) are structural
// supersets of `TransactionViewModel` below, so this file is the one place
// the shared UI components import their "transaction" type from — they
// never need to know which source produced it.
import type Decimal from "decimal.js";
import type { Category, Currency, TransactionType } from "@prisma/client";

import type { TransactionFieldErrors } from "@/lib/server/actions/transactions";

export interface TransactionViewModel {
  id: string;
  type: TransactionType;
  amount: Decimal.Value;
  currency: Currency;
  categoryId: string;
  description: string | null;
  date: Date;
  category: Pick<Category, "id" | "name" | "icon" | "color" | "type">;
}

export type TransactionMutationResult =
  | { success: true; data: TransactionViewModel }
  | { success: false; error: string; fieldErrors?: TransactionFieldErrors };

export type TransactionDeleteResult = { success: true } | { success: false; error: string };

export type TransactionListResult =
  | {
      success: true;
      data: {
        items: TransactionViewModel[];
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
      };
    }
  | { success: false; error: string };

export type CategoriesResult =
  | { success: true; data: Category[] }
  | { success: false; error: string };

export type CategoryFieldErrors = Partial<Record<"name" | "type", string[]>>;

/** Result of creating a personal category — see `createCategory` in
 * lib/server/actions/categories.ts / `createGuestCategory` in
 * lib/client/guest-store.ts. */
export type CreateCategoryResult =
  | { success: true; data: Category }
  | { success: false; error: string; fieldErrors?: CategoryFieldErrors };

/**
 * One currency's full-range (unpaginated) income/expense/net totals — see
 * `PerCurrencySummaryData` (lib/server/actions/transactions.ts, the
 * server-side counterpart this mirrors field-for-field) and
 * `summarize`'s doc comment (lib/domain/transactions/aggregate.ts) for the
 * "TRY always present, other currencies only if used, never converted
 * into one another" rule this array shape encodes. Replaces the old
 * single-currency `TransactionSummaryData` (roadmap "Çoklu Para Birimi" fix
 * — summing TRY and USD totals together was a bug). Amounts are `string`
 * (not `Decimal`), not `number` — Server Actions can't return a Prisma
 * `Decimal` instance as-is (see the "Decimal objects are not supported" dev
 * warning noted elsewhere in this codebase); the caller re-wraps with
 * `new Decimal(...)` or passes straight to `formatAmount` (which already
 * accepts a string).
 */
export interface PerCurrencySummaryData {
  currency: Currency;
  totalIncome: string;
  totalExpense: string;
  net: string;
}

/**
 * Full-range (unpaginated) per-currency totals for a filter — used by
 * `YearPickerPanel` (and anywhere else a correct total matters) instead of
 * relying on `CategoryPieChart`'s per-panel total, which is only ever
 * computed from the current PAGE of `listTransactions`/`listGuestTransactions`
 * (20 rows) and would silently under-report a full year's total once it has
 * more than one page of transactions.
 */
export type TransactionSummaryResult =
  | { success: true; data: PerCurrencySummaryData[] }
  | { success: false; error: string };

/**
 * ALL transactions matching a filter (not one page) — for Excel/PDF export.
 * Same under-reporting concern as `TransactionSummaryResult`: a filtered
 * range can easily exceed `listTransactions`' 20-row page size, and a user
 * exporting "this year's transactions" expects the whole year, not the
 * first page of it. Capped (see `EXPORT_ROW_CAP` in
 * lib/server/actions/transactions.ts / guest-store.ts) purely as a sanity
 * ceiling, not a product limit — no realistic personal-finance filter
 * range should ever hit it.
 */
export type TransactionExportResult =
  | { success: true; data: TransactionViewModel[]; truncated?: boolean }
  | { success: false; error: string };

/**
 * The date of the earliest (oldest) transaction matching a filter —
 * `"yyyy-mm-dd"` (UTC, same convention as every other stored-date read in
 * this app), or `null` if there are no matching transactions at all. Used
 * by `TrendView`'s "Yıllık" preset to find how far back a per-year chart
 * should start (the year the user's data begins), not a fixed offset like
 * every other preset — see `earliestTransactionDate` in
 * lib/server/actions/transactions.ts / `earliestGuestTransactionDate` in
 * guest-store.ts.
 */
export type EarliestTransactionDateResult =
  | { success: true; data: { date: string | null } }
  | { success: false; error: string };
