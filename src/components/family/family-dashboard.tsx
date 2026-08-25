"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { AlertCircle, Loader2, Plus } from "lucide-react";
import type { Category } from "@prisma/client";

import type { CurrencyCode, ExchangeRateTable } from "@/lib/domain/currency";
import { categoryBreakdown, summarize, type CategorySlice, type PerCurrencyTotal } from "@/lib/domain/transactions/aggregate";
import { getCurrentExchangeRates, getMyPreferredCurrency } from "@/lib/server/actions/currency";
import { createCategory, listCategories } from "@/lib/server/actions/categories";
import { removeTransactionFromFamily, softDeleteTransaction } from "@/lib/server/actions/transactions";
import {
  exportFamilyTransactions,
  familyMemberBreakdown,
  listFamilyTransactions,
  summarizeFamilyTransactions,
  type FamilyTransactionRow,
} from "@/lib/server/actions/family-transactions";
import { Button } from "@/components/ui/button";
import {
  TransactionFiltersBar,
  type TransactionFilterState,
} from "@/components/transactions/transaction-filters-bar";
import { MonthPickerPanel } from "@/components/transactions/month-picker-panel";
import { YearPickerPanel } from "@/components/transactions/year-picker-panel";
import { NetTotalCard } from "@/components/transactions/net-total-card";
import { CategoryPieChart } from "@/components/transactions/category-pie-chart";
import { DeleteTransactionDialog } from "@/components/transactions/delete-transaction-dialog";
import { ExportButtons } from "@/components/transactions/export-buttons";
import { FamilyMemberBreakdown, type FamilyBreakdownState } from "@/components/family/family-member-breakdown";
import { FamilyTransactionList, type FamilyListState } from "@/components/family/family-transaction-list";
import { FamilyTransactionForm } from "@/components/family/family-transaction-form";

const EMPTY_FILTERS: TransactionFilterState = { type: "", categoryId: "", from: "", to: "" };

/** Strips a `TransactionFilterState`'s empty-string fields down to
 * `undefined` — the shape every family-scope Server Action's
 * `transactionFiltersSchema` expects (same conversion `TransactionsView`'s
 * `fetchTransactions`/`breakdownState` effect apply to the individual
 * page's own filters). */
function toActionFilters(filters: TransactionFilterState) {
  return {
    type: filters.type || undefined,
    categoryId: filters.categoryId || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
  };
}

interface FamilyDashboardProps {
  familyId: string;
  /** Needed again for `FamilyTransactionList`'s per-row DELETE gating —
   * editing is ownership-only (any member, their own rows), but deleting a
   * family transaction additionally requires being that family's OWNER,
   * unless `membersCanDeleteOwnTransactions` below allows a member to
   * delete their own (see `canDeleteTransaction`'s doc comment in
   * lib/domain/transactions/authorization.ts). */
  isOwner: boolean;
  /** `FamilyData.membersCanDeleteOwnTransactions` — passed straight through
   * to `FamilyTransactionList` for its per-row DELETE gating; see that
   * prop's doc comment there and `MembersCanDeleteOwnTransactionsToggle`
   * ("Aile Planı Ayarları") for where it's set. */
  membersCanDeleteOwnTransactions: boolean;
  /** `FamilyData.forceShareIndividualTransactions` — passed straight through
   * to `FamilyTransactionList` for its per-row DELETE gating; see that
   * prop's doc comment there and `ForceShareToggle` ("Aile Planı Ayarları")
   * for where it's set. */
  forceShareIndividualTransactions: boolean;
  currentUserId: string | undefined;
}

/**
 * Aşama 3.5+ — "Ortak/Aile Dashboard". Carries the SAME full filter
 * experience as `TransactionsView` (individual `/transactions`): the
 * period-preset/type/category/date-range toolbar (`TransactionFiltersBar`),
 * the standalone month/year pickers, and a pie-chart + Net card pair — all
 * driven by one `TransactionFilterState`, exactly as the individual page
 * drives its own. The one structural difference is scope: every read here
 * goes through the family-scope Server Actions in
 * lib/server/actions/family-transactions.ts (this component never touches
 * `lib/client/transactions-source.ts` — that abstraction is guest/account
 * duality for INDIVIDUAL transactions, which a family plan doesn't have,
 * see CLAUDE.md "Misafir modu": a family inherently requires an account).
 * `TransactionFiltersBar`/`YearPickerPanel`/`NetTotalCard` accept plain
 * `onCreateCategory`/`onSummarize` callbacks rather than a `TransactionSource`
 * for exactly this reason — this dashboard supplies family-bound versions of
 * those calls instead of a guest/account source.
 */
export function FamilyDashboard({
  familyId,
  isOwner,
  membersCanDeleteOwnTransactions,
  forceShareIndividualTransactions,
  currentUserId,
}: FamilyDashboardProps) {
  const [filters, setFilters] = useState<TransactionFilterState>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);

  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);

  const [memberBreakdownState, setMemberBreakdownState] = useState<FamilyBreakdownState>({
    status: "loading",
  });
  const [listState, setListState] = useState<FamilyListState>({ status: "loading" });
  const [isPending, startTransition] = useTransition();

  const [formState, setFormState] = useState<{
    open: boolean;
    mode: "create" | "edit";
    transaction?: FamilyTransactionRow;
  }>({ open: false, mode: "create" });
  // Two independent targets rather than one "mode" union — each opens its
  // own `DeleteTransactionDialog` instance below, so nothing decides at
  // render time which copy/action to wire up.
  const [removeFromFamilyTarget, setRemoveFromFamilyTarget] = useState<FamilyTransactionRow | null>(null);
  const [deleteEverywhereTarget, setDeleteEverywhereTarget] = useState<FamilyTransactionRow | null>(null);

  // Guards against an out-of-order response overwriting a newer one when
  // the filters/page change quickly — same discipline as
  // TransactionsView's `requestSeq`.
  const listRequestSeq = useRef(0);

  const fetchList = useCallback(async () => {
    const seq = ++listRequestSeq.current;
    try {
      const result = await listFamilyTransactions(familyId, { ...toActionFilters(filters), page });
      if (seq !== listRequestSeq.current) return;
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
      if (seq !== listRequestSeq.current) return;
      setListState({
        status: "error",
        message: "İşlemler yüklenemedi. Bağlantınızı kontrol edip tekrar deneyin.",
      });
    }
  }, [familyId, filters, page]);

  const refetchList = useCallback(() => {
    startTransition(() => {
      fetchList();
    });
  }, [fetchList]);

  useEffect(() => {
    refetchList();
  }, [refetchList]);

  // Member breakdown re-fetches whenever the FILTER changes, not the list's
  // page — browsing page 2/3 of the same filter shouldn't re-run the
  // aggregate. Sets its own `loading` state synchronously inside a
  // `.then()` chain (never in the effect body directly), same discipline as
  // `net-total-card.tsx`/`transactions-view.tsx`'s own summary effects —
  // avoids the react-hooks/set-state-in-effect warning.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        setMemberBreakdownState({ status: "loading" });
        return familyMemberBreakdown(familyId, {
          type: filters.type || undefined,
          categoryId: filters.categoryId || undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
        });
      })
      .then((result) => {
        if (cancelled || !result) return;
        if (!result.success) {
          setMemberBreakdownState({ status: "error", message: result.error });
          return;
        }
        setMemberBreakdownState({ status: "success", rows: result.data });
      })
      .catch(() => {
        if (!cancelled) setMemberBreakdownState({ status: "error", message: "Üye dağılımı yüklenemedi." });
      });
    return () => {
      cancelled = true;
    };
  }, [familyId, filters.type, filters.categoryId, filters.from, filters.to]);

  useEffect(() => {
    let cancelled = false;
    listCategories(familyId).then((result) => {
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
  }, [familyId]);

  // Category-breakdown pie data — fetched via `exportFamilyTransactions`
  // (ALL matching transactions, not just the current page) and reduced with
  // `categoryBreakdown()`, exactly the pattern `TransactionsView` uses for
  // its own pie chart (see that file's `breakdownState` effect). Deriving
  // this from `listState.items` alone would under-report the moment a
  // filtered range holds more than one page (20 rows) of transactions.
  const [categoryBreakdownState, setCategoryBreakdownState] = useState<
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

  useEffect(() => {
    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        setCategoryBreakdownState({ status: "loading" });
        // FX rates fetched alongside the transaction rows — see
        // TransactionsView's identical breakdown effect for why
        // `getCurrentExchangeRates` needs no `familyId`/auth branching of
        // its own (a single, un-scoped rate table serves every caller).
        // `getMyPreferredCurrency` resolves the VIEWER's own preference
        // (whoever is signed in looking at this dashboard) — a family
        // plan inherently requires an account, so unlike the individual
        // page there's no guest branch to consider here.
        return Promise.all([
          exportFamilyTransactions(familyId, {
            type: filters.type || undefined,
            categoryId: filters.categoryId || undefined,
            from: filters.from || undefined,
            to: filters.to || undefined,
          }),
          getCurrentExchangeRates(),
          getMyPreferredCurrency(),
        ]);
      })
      .then((result) => {
        if (cancelled || !result) return;
        const [listResult, ratesResult, preferredCurrencyResult] = result;
        if (!listResult.success) {
          setCategoryBreakdownState({ status: "error", message: listResult.error });
          return;
        }
        if (listResult.data.length === 0) {
          setCategoryBreakdownState({ status: "idle" });
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
        const rates: ExchangeRateTable["rates"] = ratesResult.success
          ? ratesResult.data.rates
          : { USD: 0, EUR: 0 };
        const rateTable: ExchangeRateTable = { rates };
        const baseCurrency: CurrencyCode = preferredCurrencyResult.success
          ? preferredCurrencyResult.data
          : "TRY";
        const computed = categoryBreakdown(records, rateTable, baseCurrency);
        setCategoryBreakdownState({
          status: "success",
          income: computed.income,
          expense: computed.expense,
          totals: summarize(records, baseCurrency),
          rates: rateTable,
          baseCurrency,
        });
      })
      .catch(() => {
        if (!cancelled) setCategoryBreakdownState({ status: "error", message: "Grafik verisi yüklenemedi." });
      });

    return () => {
      cancelled = true;
    };
  }, [familyId, filters.type, filters.categoryId, filters.from, filters.to]);

  const handleFilterChange = (patch: Partial<TransactionFilterState>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  };
  const handleClearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };

  function openCreateDialog() {
    setFormState({ open: true, mode: "create" });
  }
  function openEditDialog(transaction: FamilyTransactionRow) {
    setFormState({ open: true, mode: "edit", transaction });
  }

  function handleSaved() {
    refetchList();
    // Member breakdown/pie data depend on `filters`, which haven't changed —
    // re-run them directly rather than only relying on the effects above
    // (which won't re-fire on their own here). `NetTotalCard`'s own `Net`
    // figure doesn't need a push from here: its `onSummarize` prop is a
    // fresh inline closure every render, so its effect (keyed on that prop)
    // already re-fires whenever this component re-renders, `refetchList()`
    // included.
    familyMemberBreakdown(familyId, toActionFilters(filters)).then((result) => {
      if (result.success) setMemberBreakdownState({ status: "success", rows: result.data });
    });
    Promise.all([
      exportFamilyTransactions(familyId, toActionFilters(filters)),
      getCurrentExchangeRates(),
      getMyPreferredCurrency(),
    ]).then(([listResult, ratesResult, preferredCurrencyResult]) => {
      if (!listResult.success) return;
      if (listResult.data.length === 0) {
        setCategoryBreakdownState({ status: "idle" });
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
      const rates: ExchangeRateTable["rates"] = ratesResult.success
        ? ratesResult.data.rates
        : { USD: 0, EUR: 0 };
      const rateTable: ExchangeRateTable = { rates };
      const baseCurrency: CurrencyCode = preferredCurrencyResult.success
        ? preferredCurrencyResult.data
        : "TRY";
      const computed = categoryBreakdown(records, rateTable, baseCurrency);
      setCategoryBreakdownState({
        status: "success",
        income: computed.income,
        expense: computed.expense,
        totals: summarize(records, baseCurrency),
        rates: rateTable,
        baseCurrency,
      });
    });
  }

  function handleDeleted() {
    if (listState.status === "success" && listState.items.length === 1 && page > 1) {
      setPage((p) => p - 1);
    } else {
      handleSaved();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-end">
        {/* "Yeni işlem ekle" is visible to EVERY member, owner or not —
            unlike edit/delete below, creating a family transaction only
            requires membership (see `createTransaction`'s `familyId`
            branch / `canCreateFamilyTransaction`). */}
        <Button onClick={openCreateDialog} size="lg">
          <Plus className="size-4" />
          Yeni işlem
        </Button>
      </div>

      {categoriesError ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          Kategoriler yüklenemedi: {categoriesError}
        </div>
      ) : null}

      <TransactionFiltersBar
        categories={categories}
        filters={filters}
        onChange={handleFilterChange}
        onClear={handleClearFilters}
        onCreateCategory={(input) => createCategory(input, familyId)}
        onCategoryCreated={(category) =>
          setCategories((prev) =>
            [...prev, category].sort(
              (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, "tr")
            )
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <MonthPickerPanel filters={filters} onChange={handleFilterChange} onClear={handleClearFilters} />
        <YearPickerPanel
          filters={filters}
          onChange={handleFilterChange}
          onClear={handleClearFilters}
          onSummarize={(f) => summarizeFamilyTransactions(familyId, f)}
          baseCurrency={categoryBreakdownState.status === "success" ? categoryBreakdownState.baseCurrency : undefined}
        />
      </div>

      {listState.status === "success" && listState.items.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            {categoryBreakdownState.status === "success" ? (
              <CategoryPieChart
                income={categoryBreakdownState.income}
                expense={categoryBreakdownState.expense}
                totals={categoryBreakdownState.totals}
                rates={categoryBreakdownState.rates}
                baseCurrency={categoryBreakdownState.baseCurrency}
                from={filters.from}
                to={filters.to}
                trendBasePath="/family/dashboard/trend"
              />
            ) : categoryBreakdownState.status === "error" ? (
              <div
                role="alert"
                className="flex h-full min-h-40 items-center justify-center rounded-xl bg-card p-6 text-center text-sm text-destructive ring-1 ring-foreground/10"
              >
                {categoryBreakdownState.message}
              </div>
            ) : (
              <div className="flex h-full min-h-40 items-center justify-center rounded-xl bg-card ring-1 ring-foreground/10">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
          <NetTotalCard
            filters={filters}
            onSummarize={(f) => summarizeFamilyTransactions(familyId, f)}
            rates={categoryBreakdownState.status === "success" ? categoryBreakdownState.rates : undefined}
            baseCurrency={categoryBreakdownState.status === "success" ? categoryBreakdownState.baseCurrency : undefined}
          />
        </div>
      ) : null}

      <FamilyMemberBreakdown state={memberBreakdownState} currentUserId={currentUserId} />

      <FamilyTransactionList
        listState={listState}
        isRefetching={isPending}
        isOwner={isOwner}
        membersCanDeleteOwnTransactions={membersCanDeleteOwnTransactions}
        forceShareIndividualTransactions={forceShareIndividualTransactions}
        currentUserId={currentUserId}
        onRetry={refetchList}
        onEdit={openEditDialog}
        onRemoveFromFamily={setRemoveFromFamilyTarget}
        onDeleteEverywhere={setDeleteEverywhereTarget}
        onPageChange={setPage}
        onCreate={openCreateDialog}
      />

      <ExportButtons filters={filters} onExportAll={(f) => exportFamilyTransactions(familyId, f)} />

      <FamilyTransactionForm
        open={formState.open}
        onOpenChange={(open) => setFormState((s) => ({ ...s, open }))}
        mode={formState.mode}
        familyId={familyId}
        transaction={formState.transaction}
        categories={categories}
        onSaved={handleSaved}
      />

      {/* Reused directly, not re-implemented: `DeleteTransactionDialog`
          (transactions/delete-transaction-dialog.tsx) isn't bound to
          `TransactionSource` the way `TransactionForm` is — it only ever
          needed a plain `(id) => Promise<{success, error?}>` callback, which
          `removeTransactionFromFamily`/`softDeleteTransaction` already are
          (their `SoftDeleteResult` is structurally identical to
          `TransactionDeleteResult`). Two instances, one per action, each
          with its own copy — see that component's `title`/`description`/
          `confirmLabel` props — so the two are never visually
          interchangeable: a slip from one to the other would either
          silently remove someone's family view (harmless) or permanently
          delete their own individual record (not). */}
      {removeFromFamilyTarget ? (
        <DeleteTransactionDialog
          open={Boolean(removeFromFamilyTarget)}
          onOpenChange={(open) => {
            if (!open) setRemoveFromFamilyTarget(null);
          }}
          transactionId={removeFromFamilyTarget.id}
          transactionLabel={`${removeFromFamilyTarget.category.name} — ${removeFromFamilyTarget.ownerName}`}
          onDelete={removeTransactionFromFamily}
          onDeleted={handleDeleted}
          title="Aile hesabından kaldır"
          confirmLabel="Aile hesabından kaldır"
          description={
            <>
              <span className="font-medium text-foreground">
                {removeFromFamilyTarget.category.name} — {removeFromFamilyTarget.ownerName}
              </span>{" "}
              kaydı aile ortak görünümünden kaldırılacak.{" "}
              {removeFromFamilyTarget.userId === currentUserId ? (
                <>Kendi bireysel hesabında aynen kalmaya devam edecek.</>
              ) : (
                <>
                  <span className="font-medium text-foreground">{removeFromFamilyTarget.ownerName}</span>{" "}
                  kişisinin kendi bireysel hesabında aynen kalmaya devam edecek.
                </>
              )}
            </>
          }
        />
      ) : null}

      {deleteEverywhereTarget ? (
        <DeleteTransactionDialog
          open={Boolean(deleteEverywhereTarget)}
          onOpenChange={(open) => {
            if (!open) setDeleteEverywhereTarget(null);
          }}
          transactionId={deleteEverywhereTarget.id}
          transactionLabel={`${deleteEverywhereTarget.category.name} — ${deleteEverywhereTarget.ownerName}`}
          onDelete={softDeleteTransaction}
          onDeleted={handleDeleted}
          title="Kalıcı olarak sil"
          confirmLabel="Evet, kalıcı olarak sil"
          description={
            <>
              <span className="font-medium text-foreground">
                {deleteEverywhereTarget.category.name} — {deleteEverywhereTarget.ownerName}
              </span>{" "}
              kaydını hem aile hesabından hem bireysel hesabından kalıcı olarak silmek istediğinize
              emin misiniz? Bu işlem geri alınamaz.
            </>
          }
        />
      ) : null}
    </div>
  );
}
