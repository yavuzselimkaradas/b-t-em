// Client-only "guest mode" data store — a localStorage-backed mirror of
// src/lib/server/actions/transactions.ts, for users who use Bütçem without
// creating an account (see CLAUDE.md "Misafir modu"). No `User` row / server
// session exists for a guest; every function here runs entirely in the
// browser and never calls a Server Action.
//
// Contract mirrors the real Server Actions on purpose (frontend-developer /
// mobile-developer already know that shape):
//  - `createGuestTransaction`   ~ `createTransaction`
//  - `updateGuestTransaction`   ~ `updateTransaction`
//  - `softDeleteGuestTransaction` ~ `softDeleteTransaction`
//  - `listGuestTransactions`    ~ `listTransactions`
//  - `listGuestCategories`      ~ `listCategories`
// Each returns the exact same RESULT SHAPE as its server counterpart
// (`{ success: true, data }` / `{ success: false, error, fieldErrors? }`),
// re-exported as `Transaction*Result` types from lib/client/transaction-view-model.ts
// so the shared UI can treat both sources identically.
//
// Validation is NOT reimplemented: this module imports the exact same Zod
// schemas from lib/validation/transaction.ts / lib/validation/category.ts
// that the server uses — a single source of truth, so a guest is bound by
// the same amount/date bounds and category/type consistency rule as a
// signed-in user. Category *existence* is checked against the fixed
// client-side default-categories.ts list PLUS any guest-created custom
// categories (see `createGuestCategory` / `CATEGORIES_STORAGE_KEY` below —
// a second, separate localStorage key from transactions, mirroring
// `createCategory` in lib/server/actions/categories.ts) — there is no
// server-side Category CRUD for guests, but there is a client-side one.
//
// Soft-delete: mirrors the DB's `deletedAt` convention (CLAUDE.md "Genel
// kurallar") for internal consistency even though there's no DB here —
// `softDeleteGuestTransaction` sets `deletedAt` rather than removing the
// record, and every read filters `deletedAt: null`.
//
// No `"use client"` directive: this is a plain function module, not a
// component, and every function guards on `isBrowser()` — it's simply
// inert (returns an empty/unavailable result) when evaluated during SSR
// rather than throwing. Only imported from Client Components in practice.
import type { Category, Currency, TransactionType } from "@prisma/client";

import {
  transactionFiltersSchema,
  transactionSchema,
  transactionUpdateSchema,
} from "@/lib/validation/transaction";
import { categorySchema } from "@/lib/validation/category";
import type { TransactionFieldErrors } from "@/lib/server/actions/transactions";
import type { CategoryFieldErrors, CreateCategoryResult } from "@/lib/server/actions/categories";
import { summarize } from "@/lib/domain/transactions";
import { DEFAULT_CATEGORIES, findDefaultCategory } from "@/lib/client/default-categories";
import type {
  CategoriesResult,
  EarliestTransactionDateResult,
  TransactionDeleteResult,
  TransactionExportResult,
  TransactionListResult,
  TransactionMutationResult,
  TransactionSummaryResult,
  TransactionViewModel,
} from "@/lib/client/transaction-view-model";

const STORAGE_KEY = "butcem:guest:transactions:v1";
/** Separate key from transactions — a distinct concern, cleared/exported
 * independently. Stores only guest-CREATED categories; the defaults stay a
 * fixed constant (default-categories.ts), never written here. */
const CATEGORIES_STORAGE_KEY = "butcem:guest:categories:v1";
const DEFAULT_PAGE_SIZE = 20;
/** Mirrors `EXPORT_ROW_CAP` in lib/server/actions/transactions.ts. */
const EXPORT_ROW_CAP = 5000;

const NOT_FOUND_MESSAGE = "İşlem bulunamadı.";
const CATEGORY_NOT_FOUND_MESSAGE = "Seçilen kategori bulunamadı.";
const CATEGORY_TYPE_MISMATCH_MESSAGE = "Seçilen kategori, işlem türüyle uyuşmuyor.";
const CATEGORY_DUPLICATE_MESSAGE = "Bu isimde ve türde bir kategori zaten var.";
const VALIDATION_ERROR_MESSAGE = "Girdiğiniz bilgileri kontrol edin.";
const FILTER_ERROR_MESSAGE = "Filtreleri kontrol edin.";
const NO_FIELDS_MESSAGE = "Güncellenecek bir alan girin.";
const STORAGE_UNAVAILABLE_MESSAGE =
  "Bu tarayıcıda yerel depolama kullanılamıyor. Verileriniz kaydedilemeyecek.";

/**
 * On-disk record shape (what actually sits in `localStorage`, JSON-encoded)
 * — dates as ISO strings, `amount` as the canonical decimal string
 * `amountSchema` produces. Deliberately does NOT embed the joined
 * `category`: only `categoryId` is stored, and the category is resolved
 * against `default-categories.ts` at read time — one less place for stored
 * data to drift from the (fixed) category list.
 */
interface StoredTransaction {
  id: string;
  type: TransactionType;
  amount: string;
  currency: Currency;
  categoryId: string;
  description: string | null;
  date: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readAll(): StoredTransaction[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredTransaction[]) : [];
  } catch {
    // Corrupt/foreign JSON under our key — treat as empty rather than
    // throwing, same spirit as the server treating a bad request as a
    // clean validation error instead of a crash.
    return [];
  }
}

function writeAll(records: StoredTransaction[]): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

/** Cheap client-side id generator, `cuid()`-shaped (`c` + lowercase
 * alphanumerics) purely so it satisfies the same "looks like an id" shape
 * conventions used elsewhere — nothing here actually re-validates a guest
 * transaction's own id against `z.cuid()`, unlike `categoryId`. */
function generateId(): string {
  const random =
    isBrowser() && "randomUUID" in window.crypto
      ? window.crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `c${random}`.toLowerCase();
}

/** Reads guest-created custom categories (defaults are never stored here —
 * see `CATEGORIES_STORAGE_KEY`'s comment). Dates round-trip through JSON as
 * strings; reconstructed into real `Date`s here so callers get the same
 * shape `Category` (Prisma's generated type) promises everywhere else. */
function readCustomCategories(): Category[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(CATEGORIES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as (Omit<Category, "createdAt" | "deletedAt"> & {
      createdAt: string;
      deletedAt: string | null;
    })[]).map((c) => ({
      ...c,
      createdAt: new Date(c.createdAt),
      deletedAt: c.deletedAt ? new Date(c.deletedAt) : null,
    }));
  } catch {
    return [];
  }
}

function writeCustomCategories(categories: Category[]): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify(categories));
}

/** Looks a category up by id across BOTH sources — the fixed defaults and
 * this browser's custom ones — so every call site that used to only know
 * about `findDefaultCategory` sees guest-created categories too. */
function findCategory(categoryId: string): Category | undefined {
  return findDefaultCategory(categoryId) ?? readCustomCategories().find((c) => c.id === categoryId);
}

function toViewModel(record: StoredTransaction, category: Category): TransactionViewModel {
  return {
    id: record.id,
    type: record.type,
    amount: record.amount,
    currency: record.currency,
    categoryId: record.categoryId,
    description: record.description,
    date: new Date(record.date),
    category,
  };
}

/** Same (categoryId, type) consistency rule as
 * `assertUsableCategory` in lib/server/actions/transactions.ts, checked
 * against the fixed default-categories.ts list instead of the DB. */
function assertUsableCategory(
  categoryId: string,
  type: TransactionType
): { ok: true; category: Category } | { ok: false; error: string; fieldErrors: TransactionFieldErrors } {
  const category = findCategory(categoryId);
  if (!category) {
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
  return { ok: true, category };
}

/**
 * Guest mirror of `createTransaction`. Same input contract (a plain object
 * shaped like `TransactionInput`, re-validated here with `transactionSchema`
 * — never trusted from the caller) and same output shape
 * (`TransactionMutationResult`).
 */
export async function createGuestTransaction(input: unknown): Promise<TransactionMutationResult> {
  if (!isBrowser()) return { success: false, error: STORAGE_UNAVAILABLE_MESSAGE };

  const parsed = transactionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as TransactionFieldErrors,
    };
  }

  const { type, amount, currency, categoryId, description, date } = parsed.data;
  const categoryCheck = assertUsableCategory(categoryId, type);
  if (!categoryCheck.ok) {
    return { success: false, error: categoryCheck.error, fieldErrors: categoryCheck.fieldErrors };
  }

  const now = new Date().toISOString();
  const record: StoredTransaction = {
    id: generateId(),
    type,
    amount,
    currency,
    categoryId,
    description: description ?? null,
    date: date.toISOString(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  const all = readAll();
  all.push(record);
  writeAll(all);

  return { success: true, data: toViewModel(record, categoryCheck.category) };
}

/**
 * Guest mirror of `updateTransaction`. `id`/`input` contract identical; a
 * non-existent (or already-deleted) id returns the same generic
 * `NOT_FOUND_MESSAGE` the server would.
 */
export async function updateGuestTransaction(
  id: string,
  input: unknown
): Promise<TransactionMutationResult> {
  if (!isBrowser()) return { success: false, error: STORAGE_UNAVAILABLE_MESSAGE };

  const all = readAll();
  const index = all.findIndex((t) => t.id === id && !t.deletedAt);
  if (index === -1) return { success: false, error: NOT_FOUND_MESSAGE };
  const existing = all[index];

  const parsed = transactionUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as TransactionFieldErrors,
    };
  }
  const patch = parsed.data;
  if (Object.keys(patch).length === 0) {
    return { success: false, error: NO_FIELDS_MESSAGE };
  }

  const effectiveType = patch.type ?? existing.type;
  const effectiveCategoryId = patch.categoryId ?? existing.categoryId;
  let effectiveCategory: Category | undefined = findCategory(existing.categoryId);

  if (patch.categoryId || patch.type) {
    const categoryCheck = assertUsableCategory(effectiveCategoryId, effectiveType);
    if (!categoryCheck.ok) {
      return { success: false, error: categoryCheck.error, fieldErrors: categoryCheck.fieldErrors };
    }
    effectiveCategory = categoryCheck.category;
  }
  if (!effectiveCategory) {
    // Should be unreachable — `existing.categoryId` always came from a
    // successful `assertUsableCategory` check at create/update time — but
    // keeps this function total instead of returning a bad view model.
    return { success: false, error: CATEGORY_NOT_FOUND_MESSAGE };
  }

  const updated: StoredTransaction = {
    ...existing,
    // Only fields the caller actually sent get overwritten — `patch` omits
    // keys it wasn't given (see the comment on `transactionUpdateSchema` in
    // lib/validation/transaction.ts), same PATCH semantics the server's
    // `db.transaction.update({ data: parsed.data })` relies on.
    ...(patch.type !== undefined ? { type: patch.type } : {}),
    ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
    ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
    ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
    ...(patch.description !== undefined ? { description: patch.description ?? null } : {}),
    ...(patch.date !== undefined ? { date: patch.date.toISOString() } : {}),
    updatedAt: new Date().toISOString(),
  };

  all[index] = updated;
  writeAll(all);

  return { success: true, data: toViewModel(updated, effectiveCategory) };
}

/**
 * Guest mirror of `softDeleteTransaction`. Idempotent in the same way: an
 * already-deleted id returns `{ success: true }`, not an error. An id that
 * never existed returns the generic `NOT_FOUND_MESSAGE`, matching the
 * server's ownership-check-first behavior.
 */
export async function softDeleteGuestTransaction(id: string): Promise<TransactionDeleteResult> {
  if (!isBrowser()) return { success: false, error: STORAGE_UNAVAILABLE_MESSAGE };

  const all = readAll();
  const index = all.findIndex((t) => t.id === id);
  if (index === -1) return { success: false, error: NOT_FOUND_MESSAGE };
  if (all[index].deletedAt) return { success: true };

  all[index] = { ...all[index], deletedAt: new Date().toISOString() };
  writeAll(all);
  return { success: true };
}

/** Shared filter predicate for `listGuestTransactions` and
 * `summarizeGuestTransactions` — mirrors `buildTransactionWhere` in
 * lib/server/actions/transactions.ts, applied in JS instead of SQL since
 * there's no database here. Always excludes soft-deleted rows. */
function filterStored(
  filters: { from?: Date; to?: Date; categoryId?: string; type?: TransactionType }
): StoredTransaction[] {
  const { from, to, categoryId, type } = filters;
  return readAll()
    .filter((t) => !t.deletedAt)
    .filter((t) => (categoryId ? t.categoryId === categoryId : true))
    .filter((t) => (type ? t.type === type : true))
    .filter((t) => {
      if (!from && !to) return true;
      const time = new Date(t.date).getTime();
      if (from && time < from.getTime()) return false;
      if (to && time > to.getTime()) return false;
      return true;
    });
}

/**
 * Guest mirror of `listTransactions`. Same `filters` contract
 * (`transactionFiltersSchema`) and same pagination shape/page size.
 */
export async function listGuestTransactions(filters: unknown = {}): Promise<TransactionListResult> {
  if (!isBrowser()) {
    return {
      success: true,
      data: { items: [], page: 1, pageSize: DEFAULT_PAGE_SIZE, total: 0, totalPages: 1 },
    };
  }

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) return { success: false, error: FILTER_ERROR_MESSAGE };
  const { from, to, categoryId, type, page } = parsed.data;

  const matches = filterStored({ from, to, categoryId, type }).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  const total = matches.length;
  const totalPages = Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE));
  const skip = (page - 1) * DEFAULT_PAGE_SIZE;

  const items: TransactionViewModel[] = [];
  for (const record of matches.slice(skip, skip + DEFAULT_PAGE_SIZE)) {
    const category = findCategory(record.categoryId);
    // A category id that no longer resolves would only happen if
    // default-categories.ts had an entry removed after data was created —
    // doesn't happen today (the list is append-only), but skip rather than
    // render a broken row if it ever does.
    if (category) items.push(toViewModel(record, category));
  }

  return { success: true, data: { items, page, pageSize: DEFAULT_PAGE_SIZE, total, totalPages } };
}

/**
 * Guest mirror of `summarizeTransactions` — full-range (unpaginated),
 * PER-CURRENCY income/expense/net totals (see `PerCurrencySummaryData`'s
 * doc comment in lib/client/transaction-view-model.ts), same reasoning as
 * the server version (a `CategoryPieChart` total computed from only the
 * current page would under-report once a range holds more than one page's
 * worth of rows) — and same "don't sum different currencies together" fix.
 */
export async function summarizeGuestTransactions(
  filters: unknown = {}
): Promise<TransactionSummaryResult> {
  if (!isBrowser()) {
    return { success: true, data: [{ currency: "TRY", totalIncome: "0", totalExpense: "0", net: "0" }] };
  }

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) return { success: false, error: FILTER_ERROR_MESSAGE };
  const { from, to, categoryId, type, baseCurrency } = parsed.data;

  const matches = filterStored({ from, to, categoryId, type });
  // Guests have no persisted `preferredCurrency` (no `User` row, no
  // `/settings` access — CLAUDE.md "Misafir modu"), so `baseCurrency` here
  // is realistically always `"TRY"` in practice — `TransactionSource`'s
  // guest `getPreferredCurrency` resolves to `"TRY"` without ever calling a
  // server action. Still honored if a caller passes something else, same as
  // the account-mode version, for symmetry.
  const perCurrency = summarize(
    matches.map((t) => ({ type: t.type, amount: t.amount, currency: t.currency })),
    baseCurrency ?? "TRY"
  );

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
 * Guest mirror of `exportTransactions` — ALL matching rows (not
 * paginated), oldest first, capped at `EXPORT_ROW_CAP`. A category id that
 * no longer resolves is skipped, same defensive handling as
 * `listGuestTransactions`.
 */
export async function exportGuestTransactions(
  filters: unknown = {}
): Promise<TransactionExportResult> {
  if (!isBrowser()) return { success: true, data: [] };

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) return { success: false, error: FILTER_ERROR_MESSAGE };
  const { from, to, categoryId, type } = parsed.data;

  const matches = filterStored({ from, to, categoryId, type }).sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const truncated = matches.length > EXPORT_ROW_CAP;
  const items: TransactionViewModel[] = [];
  for (const record of matches.slice(0, EXPORT_ROW_CAP)) {
    const category = findCategory(record.categoryId);
    if (category) items.push(toViewModel(record, category));
  }

  return { success: true, data: items, truncated };
}

/** Guest mirror of `earliestTransactionDate` — `from`/`to` in `filters` are
 * accepted but ignored (same reasoning as the server version: a bound
 * would defeat the point), only `type`/`categoryId` matter. */
export async function earliestGuestTransactionDate(
  filters: unknown = {}
): Promise<EarliestTransactionDateResult> {
  if (!isBrowser()) return { success: true, data: { date: null } };

  const parsed = transactionFiltersSchema.safeParse(filters);
  if (!parsed.success) return { success: false, error: FILTER_ERROR_MESSAGE };
  const { categoryId, type } = parsed.data;

  const matches = filterStored({ categoryId, type });
  if (matches.length === 0) return { success: true, data: { date: null } };

  const earliestTime = Math.min(...matches.map((t) => new Date(t.date).getTime()));
  return { success: true, data: { date: new Date(earliestTime).toISOString().slice(0, 10) } };
}

/** Guest mirror of `listCategories` — the fixed defaults plus whatever this
 * browser has created via `createGuestCategory`, sorted the same way the
 * server does (`type` then `name`). */
export async function listGuestCategories(): Promise<CategoriesResult> {
  const all = [...DEFAULT_CATEGORIES, ...readCustomCategories()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "tr")
  );
  return { success: true, data: all };
}

/**
 * Guest mirror of `createCategory` — same validation (`categorySchema`),
 * same case-insensitive (name, type) duplicate check against BOTH defaults
 * and this browser's existing custom categories, same `Category` shape on
 * success. Persisted under `CATEGORIES_STORAGE_KEY`, separate from
 * transactions.
 */
export async function createGuestCategory(input: unknown): Promise<CreateCategoryResult> {
  if (!isBrowser()) return { success: false, error: STORAGE_UNAVAILABLE_MESSAGE };

  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as CategoryFieldErrors,
    };
  }
  const { name, type } = parsed.data;

  const nameLower = name.toLowerCase();
  const custom = readCustomCategories();
  const duplicate = [...DEFAULT_CATEGORIES, ...custom].some(
    (category) => category.type === type && category.name.toLowerCase() === nameLower
  );
  if (duplicate) {
    return {
      success: false,
      error: CATEGORY_DUPLICATE_MESSAGE,
      fieldErrors: { name: [CATEGORY_DUPLICATE_MESSAGE] },
    };
  }

  const category: Category = {
    id: generateId(),
    name,
    type,
    isDefault: false,
    icon: null,
    color: null,
    userId: null,
    familyId: null,
    createdAt: new Date(),
    deletedAt: null,
  };
  writeCustomCategories([...custom, category]);

  return { success: true, data: category };
}
