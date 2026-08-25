"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2, Scale } from "lucide-react";

import type { PerCurrencySummaryData, TransactionSummaryResult } from "@/lib/client/transaction-view-model";
import { useScopedTranslations } from "@/lib/client/use-scoped-translations";
import type { CurrencyCode, ExchangeRateTable } from "@/lib/domain/currency";
import type { TransactionFilterState } from "@/components/transactions/transaction-filters-bar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiCurrencyAmount } from "@/components/transactions/multi-currency-amount";

interface NetTotalCardProps {
  filters: TransactionFilterState;
  /** Either `source.summarize` (lib/client/transactions-source.ts, the
   * account or guest one) on the individual page, or `(filters) =>
   * summarizeFamilyTransactions(familyId, filters)` on the family
   * dashboard — this component only needs the summarize call itself, not
   * the rest of `TransactionSource`. */
  onSummarize: (filters: unknown) => Promise<TransactionSummaryResult>;
  /** Bump this (e.g. a counter incremented on save/delete) to force a
   * re-fetch when nothing in `filters` changed — `onSummarize` is a stable
   * function reference on the individual page (`source.summarize`), so
   * without this a saved/deleted transaction leaves the Net figure stale
   * until the user touches a filter (the bug this prop fixes; see
   * `TransactionsView`'s `refreshKey`). Optional because the family
   * dashboard's `onSummarize` is a fresh closure every render instead and
   * doesn't need it. */
  refreshKey?: number;
  /** Current USD/EUR→TRY rates — forwarded to `MultiCurrencyAmount` so a
   * secondary-currency net figure also shows its primary-currency
   * equivalent. Optional/omittable the same way `MultiCurrencyAmount`'s own
   * `rates` prop is. */
  rates?: ExchangeRateTable;
  /** The account's "ana para birimi" (`TransactionSource.getPreferredCurrency`/
   * `getMyPreferredCurrency()`) — included in the `onSummarize` call so the
   * server seeds/orders `PerCurrencySummaryData[]` with THIS currency first
   * (see `transactionFiltersSchema`'s `baseCurrency` field). Defaults to
   * `"TRY"`, matching every caller that hasn't resolved a preference yet. */
  baseCurrency?: CurrencyCode;
  /** `true` on `/transactions` (tracks the active locale), omitted/`false`
   * on `/family/dashboard` (stays pinned to Turkish) — see
   * lib/client/use-scoped-translations.ts's doc comment. */
  translate?: boolean;
}

type NetState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; rows: PerCurrencySummaryData[] };

/**
 * Standalone "Net" card, rendered next to `CategoryPieChart` — same idea as
 * `YearPickerPanel`'s net figure: fetched via `source.summarize` (full
 * matching range, DB-side sum), NOT derived from `listState.items`/
 * `categoryBreakdown` like the pie chart's own per-panel totals are.
 * Reason this has to be separate: the pie chart's totals are only ever
 * computed from the currently-loaded PAGE (20 rows) of `list`, which
 * under-reports for any filter matching more than that — same
 * under-reporting risk `YearPickerPanel` and `ExportButtons` already avoid
 * by going through `summarize`/`exportAll` instead of the page. Reacts to
 * whatever filter is currently active (not just a picked year), since it
 * sits next to the general-purpose pie chart, not inside the year panel.
 */
export function NetTotalCard({
  filters,
  onSummarize,
  refreshKey,
  rates,
  baseCurrency = "TRY",
  translate = false,
}: NetTotalCardProps) {
  const t = useScopedTranslations("transactions.netCard", translate);
  const [state, setState] = useState<NetState>({ status: "loading" });

  // Every state update happens inside a `.then()`/`.catch()` callback, never
  // synchronously in the effect body — same discipline as YearPickerPanel's
  // summary effect (see its comment for why: avoids the
  // react-hooks/set-state-in-effect cascading-render warning).
  useEffect(() => {
    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        setState({ status: "loading" });
        return onSummarize({
          type: filters.type || undefined,
          categoryId: filters.categoryId || undefined,
          from: filters.from || undefined,
          to: filters.to || undefined,
          baseCurrency,
        });
      })
      .then((result) => {
        if (cancelled || !result) return;
        if (!result.success) {
          setState({ status: "error", message: result.error });
          return;
        }
        setState({ status: "success", rows: result.data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: t("loadError") });
      });

    return () => {
      cancelled = true;
    };
  }, [
    filters.type,
    filters.categoryId,
    filters.from,
    filters.to,
    onSummarize,
    refreshKey,
    baseCurrency,
    t,
  ]);

  return (
    <Card>
      <CardHeader className="[.border-b]:pb-0">
        <CardTitle className="flex items-center gap-1.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-foreground">
            <Scale className="size-3.5" strokeWidth={2.5} />
          </span>
          {t("title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex h-full min-h-24 flex-col items-center justify-center gap-1 text-center">
        {state.status === "loading" ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : state.status === "error" ? (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertCircle className="size-3.5 shrink-0" />
            {state.message}
          </p>
        ) : (
          <MultiCurrencyAmount rows={state.rows} field="net" size="lg" rates={rates} />
        )}
      </CardContent>
    </Card>
  );
}
