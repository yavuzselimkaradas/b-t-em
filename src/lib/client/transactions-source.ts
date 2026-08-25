// Thin adapter that picks WHICH data source the shared transaction UI talks
// to — the real Server Actions (signed-in) or the localStorage-backed guest
// store (no account, see CLAUDE.md "Misafir modu"). This is the ONLY place
// that branches on "account vs. guest": TransactionsView / TransactionForm /
// DeleteTransactionDialog stay source-agnostic, calling whichever
// `TransactionSource` this returns and rendering `TransactionViewModel`
// (lib/client/transaction-view-model.ts) either way.
import {
  createTransaction,
  earliestTransactionDate,
  exportTransactions,
  listTransactions,
  softDeleteTransaction,
  summarizeTransactions,
  updateTransaction,
} from "@/lib/server/actions/transactions";
import { createCategory, listCategories } from "@/lib/server/actions/categories";
import { getMyPreferredCurrency, type PreferredCurrencyResult } from "@/lib/server/actions/currency";
import {
  createGuestTransaction,
  earliestGuestTransactionDate,
  exportGuestTransactions,
  listGuestTransactions,
  softDeleteGuestTransaction,
  summarizeGuestTransactions,
  updateGuestTransaction,
  listGuestCategories,
  createGuestCategory,
} from "@/lib/client/guest-store";
import type {
  CategoriesResult,
  CreateCategoryResult,
  EarliestTransactionDateResult,
  TransactionDeleteResult,
  TransactionExportResult,
  TransactionListResult,
  TransactionMutationResult,
  TransactionSummaryResult,
} from "@/lib/client/transaction-view-model";

export type TransactionSourceMode = "account" | "guest";

export interface TransactionSource {
  list: (filters: unknown) => Promise<TransactionListResult>;
  create: (input: unknown) => Promise<TransactionMutationResult>;
  update: (id: string, input: unknown) => Promise<TransactionMutationResult>;
  softDelete: (id: string) => Promise<TransactionDeleteResult>;
  listCategories: () => Promise<CategoriesResult>;
  /** Creates a personal category (`isDefault: false`, owned by this user/
   * browser) — see CreateCategoryResult's doc comment. */
  createCategory: (input: unknown) => Promise<CreateCategoryResult>;
  /** Full-range (unpaginated) totals — see TransactionSummaryResult's doc
   * comment for why this exists separately from `list`. */
  summarize: (filters: unknown) => Promise<TransactionSummaryResult>;
  /** Full-range (unpaginated) rows, oldest first — for Excel/PDF export.
   * See TransactionExportResult's doc comment. */
  exportAll: (filters: unknown) => Promise<TransactionExportResult>;
  /** Earliest matching transaction's date — see
   * EarliestTransactionDateResult's doc comment. */
  earliestDate: (filters: unknown) => Promise<EarliestTransactionDateResult>;
  /** The account's "ana para birimi" — `User.preferredCurrency`
   * (`getMyPreferredCurrency()`) for account mode, always `"TRY"` for guest
   * mode (no persisted preference, no `/settings` access — CLAUDE.md
   * "Misafir modu"). `TransactionsView` resolves this once alongside
   * `exportAll`/rates and threads it through as `categoryBreakdown`/
   * `summarize`'s `baseCurrency` argument. */
  getPreferredCurrency: () => Promise<PreferredCurrencyResult>;
}

const ACCOUNT_SOURCE: TransactionSource = {
  list: listTransactions,
  create: createTransaction,
  update: updateTransaction,
  softDelete: softDeleteTransaction,
  listCategories,
  createCategory,
  summarize: summarizeTransactions,
  exportAll: exportTransactions,
  earliestDate: earliestTransactionDate,
  getPreferredCurrency: getMyPreferredCurrency,
};

const GUEST_SOURCE: TransactionSource = {
  list: listGuestTransactions,
  create: createGuestTransaction,
  update: updateGuestTransaction,
  softDelete: softDeleteGuestTransaction,
  listCategories: listGuestCategories,
  createCategory: createGuestCategory,
  summarize: summarizeGuestTransactions,
  exportAll: exportGuestTransactions,
  earliestDate: earliestGuestTransactionDate,
  // No persisted preference for guests — always resolves to `"TRY"`,
  // synchronously wrapped in a `Promise` to match the interface's shape.
  getPreferredCurrency: async () => ({ success: true, data: "TRY" }),
};

export function getTransactionSource(mode: TransactionSourceMode): TransactionSource {
  return mode === "guest" ? GUEST_SOURCE : ACCOUNT_SOURCE;
}
