"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MoreVertical,
  NotebookPen,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { Category } from "@prisma/client";

import { cn } from "@/lib/utils";
import { formatAmount, type CurrencyCode, type ExchangeRateTable } from "@/lib/domain/currency";
import { categoryBreakdown, summarize, type CategorySlice, type PerCurrencyTotal } from "@/lib/domain/transactions/aggregate";
import { getCurrentExchangeRates } from "@/lib/server/actions/currency";
import { getTransactionSource, type TransactionSourceMode } from "@/lib/client/transactions-source";
import type { TransactionViewModel } from "@/lib/client/transaction-view-model";
import { toIntlLocale } from "@/lib/client/intl-locale";
import type { Locale } from "@/i18n/locale";
import { PlanSwitcher } from "@/components/app/plan-switcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TransactionFiltersBar,
  type TransactionFilterState,
  type TypeFilterValue,
} from "@/components/transactions/transaction-filters-bar";
import { MonthPickerPanel } from "@/components/transactions/month-picker-panel";
import { YearPickerPanel } from "@/components/transactions/year-picker-panel";
import { TransactionForm } from "@/components/transactions/transaction-form";
import { DeleteTransactionDialog } from "@/components/transactions/delete-transaction-dialog";
import { getCategoryVisual } from "@/components/transactions/category-visual";
import { CategoryPieChart } from "@/components/transactions/category-pie-chart";
import { NetTotalCard } from "@/components/transactions/net-total-card";
import { ExportButtons } from "@/components/transactions/export-buttons";

function parseFiltersFromSearchParams(searchParams: URLSearchParams): {
  filters: TransactionFilterState;
  page: number;
} {
  const rawType = searchParams.get("type");
  const type: TypeFilterValue = rawType === "INCOME" || rawType === "EXPENSE" ? rawType : "";
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);

  return {
    filters: {
      type,
      categoryId: searchParams.get("categoryId") ?? "",
      from: searchParams.get("from") ?? "",
      to: searchParams.get("to") ?? "",
    },
    page,
  };
}

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "success";
      items: TransactionViewModel[];
      page: number;
      totalPages: number;
      total: number;
    };

interface TransactionsViewProps {
  /** "account" (signed in — Server Actions) or "guest" (no session —
   * localStorage, see lib/client/guest-store.ts). Decided server-side by the
   * page (via `auth()`) and passed down once; this component never checks
   * the session itself. */
  mode: TransactionSourceMode;
}

export function TransactionsView({ mode }: TransactionsViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const source = getTransactionSource(mode);
  const t = useTranslations("transactions");

  const { filters, page } = parseFiltersFromSearchParams(searchParams);

  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);

  const [listState, setListState] = useState<ListState>({ status: "loading" });
  const [isPending, startTransition] = useTransition();

  const [formState, setFormState] = useState<{
    open: boolean;
    mode: "create" | "edit";
    transaction?: TransactionViewModel;
  }>({ open: false, mode: "create" });

  const [deleteTarget, setDeleteTarget] = useState<TransactionViewModel | null>(null);

  // Guards against an out-of-order response overwriting a newer one when
  // filters/page change quickly (e.g. someone clicking through pages fast).
  const requestSeq = useRef(0);
  // Same out-of-order guard, for the pie chart/totals fetch below.
  const breakdownSeq = useRef(0);
  // Bumped on every save/delete — passed to `NetTotalCard`/`YearPickerPanel`
  // as `refreshKey` so they re-fetch even when no filter changed. Both call
  // `source.summarize`, a stable module-level function reference (unlike the
  // family dashboard's inline closure), so without this they'd go stale
  // exactly like `fetchBreakdown` did before its own fix above.
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchTransactions = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const result = await source.list({
        type: filters.type || undefined,
        categoryId: filters.categoryId || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        page,
      });
      if (seq !== requestSeq.current) return;

      if (!result.success) {
        setListState({ status: "error", message: result.error });
        return;
      }
      setListState({
        status: "success",
        items: result.data.items,
        page: result.data.page,
        totalPages: result.data.totalPages,
        total: result.data.total,
      });
    } catch {
      if (seq !== requestSeq.current) return;
      setListState({
        status: "error",
        message: t("list.loadErrorFallback"),
      });
    }
  }, [filters.type, filters.categoryId, filters.from, filters.to, page, source, t]);

  // Every call site routes through this wrapper (not `fetchTransactions`
  // directly) so `isPending` — used to dim the table during a refetch —
  // stays accurate no matter what triggered the refetch. Wrapping in
  // `startTransition` (rather than calling `fetchTransactions()` straight
  // from the effect) is also what keeps this the React-endorsed shape for
  // "an effect that starts an async fetch and later updates state" — see
  // https://react.dev/learn/you-might-not-need-an-effect.
  const refetch = useCallback(() => {
    startTransition(() => {
      fetchTransactions();
    });
  }, [fetchTransactions]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    let cancelled = false;
    source.listCategories().then((result) => {
      if (cancelled) return;
      if (!result.success) {
        setCategoriesError(result.error);
        return;
      }
      setCategories(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const updateUrl = useCallback(
    (patch: Partial<TransactionFilterState> & { page?: number }, resetPage: boolean) => {
      const params = new URLSearchParams(searchParams.toString());
      const next = { ...filters, ...patch };

      for (const key of ["type", "categoryId", "from", "to"] as const) {
        const value = next[key];
        if (value) params.set(key, value);
        else params.delete(key);
      }

      const nextPage = patch.page ?? (resetPage ? 1 : page);
      if (nextPage > 1) params.set("page", String(nextPage));
      else params.delete("page");

      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [filters, page, pathname, router, searchParams]
  );

  const handleFilterChange = (patch: Partial<TransactionFilterState>) =>
    updateUrl(patch, true);
  const handleClearFilters = () =>
    updateUrl({ type: "", categoryId: "", from: "", to: "" }, true);
  const handlePageChange = (nextPage: number) => updateUrl({ page: nextPage }, false);

  const openCreateDialog = () => setFormState({ open: true, mode: "create" });
  const openEditDialog = (transaction: TransactionViewModel) =>
    setFormState({ open: true, mode: "edit", transaction });

  // Both handlers also refresh the pie chart/totals directly — `page`/`filters`
  // (the effect's own deps) don't change on a plain save or same-page delete,
  // so without this the chart would silently go stale until the user touched
  // a filter (see `fetchBreakdown`'s comment for the bug this fixes).
  const handleSaved = () => {
    refetch();
    fetchBreakdown();
    setRefreshKey((k) => k + 1);
  };

  const handleDeleted = () => {
    // If this page is now empty because of the delete and it isn't page 1,
    // step back a page instead of showing a dead-end empty page.
    if (listState.status === "success" && listState.items.length === 1 && page > 1) {
      updateUrl({ page: page - 1 }, false);
    } else {
      refetch();
    }
    fetchBreakdown();
    setRefreshKey((k) => k + 1);
  };

  const hasActiveFilters = Boolean(
    filters.type || filters.categoryId || filters.from || filters.to
  );

  // Fetched via `source.exportAll` (ALL matching transactions, not just the
  // current page — the same full-range call ExportButtons and
  // YearPickerPanel/NetTotalCard already use) rather than derived from
  // `listState.items`. Deriving it from the loaded page alone would
  // under-report the pie chart the moment a filtered range holds more than
  // one page (20 rows) — the exact bug this replaces. Re-fetches whenever
  // the FILTER changes, not the page (browsing pages 2/3/... of the same
  // filter shouldn't refetch/redraw the chart).
  const [breakdownState, setBreakdownState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | {
        status: "success";
        income: CategorySlice[];
        expense: CategorySlice[];
        totals: PerCurrencyTotal[];
        rates: ExchangeRateTable;
        baseCurrency: CurrencyCode;
      }
  >({ status: "idle" });

  // Every state update happens inside a `.then()`/`.catch()` callback, never
  // synchronously in the effect body — same discipline as
  // NetTotalCard/YearPickerPanel's summary effects (see their comments for
  // why: avoids the react-hooks/set-state-in-effect cascading-render
  // warning).
  // `useCallback` (not inlined in the effect below) so `handleSaved`/
  // `handleDeleted` can also trigger it directly — a saved/deleted
  // transaction changes the breakdown even when no FILTER changed, which the
  // effect's dependency array alone would never catch (that was the actual
  // bug: adding a USD transaction updated the table via `refetch()` but left
  // this chart/totals stale until the user touched a filter or reloaded).
  const fetchBreakdown = useCallback(async () => {
    const seq = ++breakdownSeq.current;
    setBreakdownState({ status: "loading" });
    try {
      // FX rates and the account's preferred currency are fetched alongside
      // the transaction rows, unauthenticated for rates (`getCurrentExchangeRates`
      // — no `auth()` call, works in guest mode too, see CLAUDE.md "Misafir
      // modu") but `source.getPreferredCurrency` resolves to `"TRY"` for
      // guests directly (no server round-trip) — `categoryBreakdown` needs a
      // rate table to size pie slices across currencies even for a guest,
      // and a base currency to size/order them AGAINST.
      const [listResult, ratesResult, preferredCurrencyResult] = await Promise.all([
        source.exportAll({
          type: filters.type || undefined,
          categoryId: filters.categoryId || undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
        }),
        getCurrentExchangeRates(),
        source.getPreferredCurrency(),
      ]);
      if (seq !== breakdownSeq.current) return;

      if (!listResult.success) {
        setBreakdownState({ status: "error", message: listResult.error });
        return;
      }
      if (listResult.data.length === 0) {
        setBreakdownState({ status: "idle" });
        return;
      }
      const records = listResult.data.map((transaction) => ({
        type: transaction.type,
        amount: transaction.amount,
        currency: transaction.currency,
        categoryId: transaction.categoryId,
        categoryName: transaction.category.name,
        color: transaction.category.color,
      }));
      // FX fetch failure still resolves `{ success: true }` in the
      // overwhelming majority of real-world cases (see
      // `getCurrentExchangeRates`'s doc comment — it falls back to a last-
      // known/hardcoded rate rather than erroring); an explicit
      // `{ success: false }` here is defense-in-depth, falling back to an
      // empty rate table (only matters if a mixed-currency category exists
      // AND the fallback itself somehow also failed, an extreme edge case)
      // rather than blocking the whole chart on it.
      const rates: ExchangeRateTable["rates"] = ratesResult.success
        ? ratesResult.data.rates
        : { USD: 0, EUR: 0 };
      const rateTable: ExchangeRateTable = { rates };
      // Same defense-in-depth reasoning as `rates` above — a failed lookup
      // (session raced out from under us, DB hiccup) falls back to "TRY"
      // rather than blocking the chart.
      const baseCurrency: CurrencyCode = preferredCurrencyResult.success
        ? preferredCurrencyResult.data
        : "TRY";
      const computed = categoryBreakdown(records, rateTable, baseCurrency);
      setBreakdownState({
        status: "success",
        income: computed.income,
        expense: computed.expense,
        totals: summarize(records, baseCurrency),
        rates: rateTable,
        baseCurrency,
      });
    } catch {
      if (seq === breakdownSeq.current) {
        setBreakdownState({ status: "error", message: t("breakdownLoadError") });
      }
    }
  }, [filters.type, filters.categoryId, filters.from, filters.to, source, t]);

  useEffect(() => {
    fetchBreakdown();
  }, [fetchBreakdown]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
            {t("page.title")}
          </h1>
          <p className="mt-1.5 text-muted-foreground">{t("page.subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          <PlanSwitcher
            active="individual"
            individualLabel={t("planSwitcher.individual")}
            familyLabel={t("planSwitcher.family")}
          />
          <Button onClick={openCreateDialog} size="lg">
            <Plus className="size-4" />
            {t("newTransaction")}
          </Button>
        </div>
      </div>

      {categoriesError ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {t("categoriesLoadError", { message: categoriesError })}
        </div>
      ) : null}

      <TransactionFiltersBar
        categories={categories}
        filters={filters}
        onChange={handleFilterChange}
        onClear={handleClearFilters}
        onCreateCategory={source.createCategory}
        onCategoryCreated={(category) =>
          setCategories((prev) =>
            [...prev, category].sort(
              (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "tr")
            )
          )
        }
        translate
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <MonthPickerPanel
          filters={filters}
          onChange={handleFilterChange}
          onClear={handleClearFilters}
          translate
        />
        <YearPickerPanel
          filters={filters}
          onChange={handleFilterChange}
          onClear={handleClearFilters}
          onSummarize={source.summarize}
          refreshKey={refreshKey}
          baseCurrency={breakdownState.status === "success" ? breakdownState.baseCurrency : undefined}
          translate
        />
      </div>

      {listState.status === "success" && listState.items.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            {breakdownState.status === "success" ? (
              <CategoryPieChart
                income={breakdownState.income}
                expense={breakdownState.expense}
                totals={breakdownState.totals}
                rates={breakdownState.rates}
                baseCurrency={breakdownState.baseCurrency}
                from={filters.from}
                to={filters.to}
                translate
              />
            ) : breakdownState.status === "error" ? (
              <div
                role="alert"
                className="flex h-full min-h-40 items-center justify-center rounded-xl bg-card p-6 text-center text-sm text-destructive ring-1 ring-foreground/10"
              >
                {breakdownState.message}
              </div>
            ) : (
              <div className="flex h-full min-h-40 items-center justify-center rounded-xl bg-card ring-1 ring-foreground/10">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
          <NetTotalCard
            filters={filters}
            onSummarize={source.summarize}
            refreshKey={refreshKey}
            rates={breakdownState.status === "success" ? breakdownState.rates : undefined}
            baseCurrency={breakdownState.status === "success" ? breakdownState.baseCurrency : undefined}
            translate
          />
        </div>
      ) : null}

      <TransactionListBody
        listState={listState}
        isRefetching={isPending}
        hasActiveFilters={hasActiveFilters}
        onRetry={refetch}
        onClearFilters={handleClearFilters}
        onCreate={openCreateDialog}
        onEdit={openEditDialog}
        onDeleteRequest={setDeleteTarget}
        onPageChange={handlePageChange}
      />

      <ExportButtons filters={filters} onExportAll={source.exportAll} translate />

      <TransactionForm
        open={formState.open}
        onOpenChange={(open) => setFormState((s) => ({ ...s, open }))}
        mode={formState.mode}
        transaction={formState.transaction}
        categories={categories}
        source={source}
        onSaved={handleSaved}
      />

      {deleteTarget ? (
        <DeleteTransactionDialog
          open={Boolean(deleteTarget)}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          transactionId={deleteTarget.id}
          transactionLabel={`${deleteTarget.category.name} — ${formatAmount(
            deleteTarget.amount,
            deleteTarget.currency
          )}`}
          onDelete={source.softDelete}
          onDeleted={handleDeleted}
        />
      ) : null}
    </div>
  );
}

function TransactionListBody({
  listState,
  isRefetching,
  hasActiveFilters,
  onRetry,
  onClearFilters,
  onCreate,
  onEdit,
  onDeleteRequest,
  onPageChange,
}: {
  listState: ListState;
  isRefetching: boolean;
  hasActiveFilters: boolean;
  onRetry: () => void;
  onClearFilters: () => void;
  onCreate: () => void;
  onEdit: (transaction: TransactionViewModel) => void;
  onDeleteRequest: (transaction: TransactionViewModel) => void;
  onPageChange: (page: number) => void;
}) {
  const t = useTranslations("transactions.list");

  if (listState.status === "loading") {
    return <TransactionsSkeleton />;
  }

  if (listState.status === "error") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl bg-card py-14 text-center ring-1 ring-foreground/10">
        <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertCircle className="size-6" strokeWidth={2} />
        </span>
        <div>
          <p className="font-medium text-foreground">{t("loadError")}</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{listState.message}</p>
        </div>
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          {t("retry")}
        </Button>
      </div>
    );
  }

  if (listState.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border bg-transparent py-14 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand-soft-foreground">
          <NotebookPen className="size-6" strokeWidth={2} />
        </span>
        {hasActiveFilters ? (
          <div>
            <p className="font-medium text-foreground">{t("emptyFilteredTitle")}</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("emptyFilteredBody")}</p>
            <Button variant="outline" className="mt-4" onClick={onClearFilters}>
              {t("clearFilters")}
            </Button>
          </div>
        ) : (
          <div>
            <p className="font-medium text-foreground">{t("emptyTitle")}</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("emptyBody")}</p>
            <Button className="mt-4" onClick={onCreate}>
              <Plus className="size-4" />
              {t("emptyCta")}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 transition-opacity",
          isRefetching && "pointer-events-none opacity-60"
        )}
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t("columnDate")}</TableHead>
              <TableHead>{t("columnCategory")}</TableHead>
              <TableHead>{t("columnDescription")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("columnType")}</TableHead>
              <TableHead className="text-right">{t("columnAmount")}</TableHead>
              <TableHead className="w-9" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {listState.items.map((transaction) => (
              <TransactionRow
                key={transaction.id}
                transaction={transaction}
                onEdit={() => onEdit(transaction)}
                onDelete={() => onDeleteRequest(transaction)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
        <span>{t("totalCount", { count: listState.total })}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={listState.page <= 1}
            onClick={() => onPageChange(listState.page - 1)}
          >
            <ChevronLeft className="size-3.5" />
            {t("previous")}
          </Button>
          <span className="tabular-nums">
            {t("pageOf", { page: listState.page, totalPages: listState.totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={listState.page >= listState.totalPages}
            onClick={() => onPageChange(listState.page + 1)}
          >
            {t("next")}
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function TransactionRow({
  transaction,
  onEdit,
  onDelete,
}: {
  transaction: TransactionViewModel;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("transactions.list");
  const locale = useLocale() as Locale;
  const dateFormatter = new Intl.DateTimeFormat(toIntlLocale(locale), {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC", // dates are stored as UTC midnight — see transaction-form.tsx
  });
  const isIncome = transaction.type === "INCOME";
  const visual = getCategoryVisual(transaction.category);
  const Icon = visual.icon;

  return (
    <TableRow>
      <TableCell className="text-muted-foreground">{dateFormatter.format(transaction.date)}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full",
              visual.bg,
              visual.fg
            )}
          >
            <Icon className="size-3.5" strokeWidth={2.25} />
          </span>
          <span className="font-medium text-foreground">{transaction.category.name}</span>
        </div>
      </TableCell>
      <TableCell className="max-w-56 truncate text-muted-foreground" title={transaction.description ?? undefined}>
        {transaction.description || <span className="text-muted-foreground/50">—</span>}
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        {isIncome ? (
          <Badge className="gap-1 border-transparent bg-income-soft text-income">
            <ArrowUpRight className="size-3" strokeWidth={2.5} />
            {t("typeIncome")}
          </Badge>
        ) : (
          <Badge variant="destructive" className="gap-1">
            <ArrowDownRight className="size-3" strokeWidth={2.5} />
            {t("typeExpense")}
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <span
          className={cn(
            "num-tabular inline-flex items-center gap-1 font-medium",
            isIncome ? "text-income" : "text-destructive"
          )}
        >
          {isIncome ? (
            <ArrowUpRight className="size-3.5" strokeWidth={2.5} />
          ) : (
            <ArrowDownRight className="size-3.5" strokeWidth={2.5} />
          )}
          {isIncome ? "+" : "−"}
          {formatAmount(transaction.amount, transaction.currency)}
        </span>
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label={t("rowOptionsAria")}>
                <MoreVertical />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="size-4" />
              {t("edit")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="size-4" />
              {t("delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function TransactionsSkeleton() {
  const t = useTranslations("transactions.list");
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t("columnDate")}</TableHead>
            <TableHead>{t("columnCategory")}</TableHead>
            <TableHead>{t("columnDescription")}</TableHead>
            <TableHead className="hidden sm:table-cell">{t("columnType")}</TableHead>
            <TableHead className="text-right">{t("columnAmount")}</TableHead>
            <TableHead className="w-9" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 6 }).map((_, index) => (
            <TableRow key={index} className="hover:bg-transparent">
              <TableCell>
                <div className="h-4 w-20 animate-pulse rounded bg-muted" />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <div className="size-7 animate-pulse rounded-full bg-muted" />
                  <div className="h-4 w-24 animate-pulse rounded bg-muted" />
                </div>
              </TableCell>
              <TableCell>
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                <div className="h-5 w-14 animate-pulse rounded-full bg-muted" />
              </TableCell>
              <TableCell className="text-right">
                <div className="ml-auto h-4 w-20 animate-pulse rounded bg-muted" />
              </TableCell>
              <TableCell>
                <div className="size-6 animate-pulse rounded bg-muted" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
