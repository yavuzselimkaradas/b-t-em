"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, FilterX, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatAmount, type CurrencyCode } from "@/lib/domain/currency";
import { useScopedTranslations } from "@/lib/client/use-scoped-translations";
import type { PerCurrencySummaryData, TransactionSummaryResult } from "@/lib/client/transaction-view-model";
import {
  clampToToday,
  toInputValue,
  type TransactionFilterState,
} from "@/components/transactions/transaction-filters-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface YearPickerPanelProps {
  filters: TransactionFilterState;
  onChange: (patch: Partial<TransactionFilterState>) => void;
  onClear: () => void;
  /** Either `source.summarize` (lib/client/transactions-source.ts, the
   * account or guest one) on the individual page, or `(filters) =>
   * summarizeFamilyTransactions(familyId, filters)` on the family
   * dashboard — this component only needs the summarize call itself, not
   * the rest of `TransactionSource`. */
  onSummarize: (filters: unknown) => Promise<TransactionSummaryResult>;
  /** Bump this (e.g. a counter incremented on save/delete) to force a
   * re-fetch when nothing in `filters` changed — see `NetTotalCard`'s
   * identical prop for why (`onSummarize` is a stable reference on the
   * individual page, so a saved/deleted transaction wouldn't otherwise
   * refresh the shown year total). */
  refreshKey?: number;
  /** The account's "ana para birimi" — included in the `onSummarize` call so
   * the year total's rows are seeded/ordered with THIS currency first, same
   * contract as `NetTotalCard`'s identical prop. Defaults to `"TRY"`. */
  baseCurrency?: CurrencyCode;
  /** `true` on `/transactions` (tracks the active locale), omitted/`false`
   * on `/family/dashboard` (stays pinned to Turkish) — see
   * lib/client/use-scoped-translations.ts's doc comment. */
  translate?: boolean;
}

const CURRENT_YEAR = new Date().getFullYear();
/** Arbitrary but generous floor — just enough to keep the input from
 * accepting nonsense like "0" or a 6-digit year; there's no real minimum
 * (a user may have years of backfilled history). */
const MIN_YEAR = 1970;
const YEARS_PER_PAGE = 12;

function startOfYearPage(year: number): number {
  return Math.floor(year / YEARS_PER_PAGE) * YEARS_PER_PAGE;
}

/** Resolves the current filters to a selected year only when they exactly
 * span Jan 1 → Dec 31 of that year (or, for the current year, Jan 1 →
 * today — see `applyYear`'s clamping, same reasoning as
 * `month-picker-panel.tsx`'s `currentFilterAsMonthValue`). */
function currentFilterAsYear(filters: TransactionFilterState): number | null {
  if (!filters.from || !filters.to) return null;
  const yearFromFrom = filters.from.slice(0, 4);
  if (filters.from !== `${yearFromFrom}-01-01`) return null;
  const year = Number(yearFromFrom);
  if (!Number.isInteger(year)) return null;

  const today = toInputValue(new Date());
  const expectedTo = clampToToday(`${yearFromFrom}-12-31`, today);
  return filters.to === expectedTo ? year : null;
}

/**
 * Standalone panel, next to `MonthPickerPanel`, for viewing a whole
 * calendar year's income/expense totals rather than a single month.
 * Applying it sets the same `from`/`to` the other filters use (so the
 * table below reflects it too), but ALSO fetches its own accurate total
 * via `source.summarize` — `CategoryPieChart`'s per-panel total is only
 * computed from the current page of `list` (20 rows) and would
 * under-report for any year with more transactions than that.
 *
 * Two equally-valid ways to pick a year, per the product requirement:
 * typing one directly into the number input (Enter or "Görüntüle"
 * applies it), or opening the calendar-icon button's picker — a paged
 * 12-year grid, the same "click a screen, pick from it" feel as
 * `MonthPickerPanel`'s native `<input type="month">`, since there's no
 * native `<input type="year">` to borrow that UI from directly.
 */
export function YearPickerPanel({
  filters,
  onChange,
  onClear,
  onSummarize,
  refreshKey,
  baseCurrency = "TRY",
  translate = false,
}: YearPickerPanelProps) {
  const t = useScopedTranslations("transactions.yearPicker", translate);
  const selectedYear = currentFilterAsYear(filters);
  // Same condition as TransactionFiltersBar's / MonthPickerPanel's own clear
  // button — any active filter, not just a picked year, so this shortcut
  // works no matter which control set it.
  const hasActiveFilters = Boolean(
    filters.type || filters.categoryId || filters.from || filters.to
  );
  const [draft, setDraft] = useState(selectedYear ? String(selectedYear) : "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pageStart, setPageStart] = useState(() => startOfYearPage(selectedYear ?? CURRENT_YEAR));
  const [summary, setSummary] = useState<PerCurrencySummaryData[] | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Note: no effect syncing `draft` back to `selectedYear` when some OTHER
  // control (a Dönem preset, "Filtreleri temizle") changes the filters out
  // from underneath — `draft` only needs to be right on first render
  // (handled by the lazy `useState` initializer above, e.g. a shared
  // year-filtered URL), matching how `custom-monthly-range-button.tsx`'s
  // day draft similarly doesn't auto-reset on unrelated filter changes.

  // Fetches the accurate, full-range total whenever the active filters
  // resolve to a selected year — re-derives from `filters` (not from the
  // apply action) so refreshing/navigating back to a year-filtered URL
  // still shows the right total, not just right after picking one.
  // `selectedYear` alone (not rendered when falsy, see the JSX below) is
  // what gates whether anything here is ever shown — so there's nothing to
  // reset when it's null, only something to fetch when it's set. Every
  // state update happens inside a `.then()`/`.catch()`/`.finally()`
  // callback, never synchronously in the effect body, matching this file's
  // sibling effects elsewhere in the app (e.g. transactions-view.tsx's
  // category-loading effect).
  useEffect(() => {
    if (!selectedYear) return;
    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        setLoading(true);
        setSummaryError(null);
        return onSummarize({ from: filters.from, to: filters.to, baseCurrency });
      })
      .then((result) => {
        if (cancelled || !result) return;
        if (!result.success) {
          setSummaryError(result.error);
          return;
        }
        setSummary(result.data);
      })
      .catch(() => {
        if (!cancelled) setSummaryError(t("loadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedYear, filters.from, filters.to, onSummarize, refreshKey, baseCurrency, t]);

  const applyYearValue = (year: number) => {
    if (!Number.isInteger(year) || year < MIN_YEAR || year > CURRENT_YEAR) return;
    setDraft(String(year));
    const today = toInputValue(new Date());
    onChange({
      from: `${year}-01-01`,
      to: clampToToday(`${year}-12-31`, today),
    });
  };

  const applyDraft = () => applyYearValue(Number.parseInt(draft, 10));

  const openPicker = () => {
    setPageStart(startOfYearPage(selectedYear ?? CURRENT_YEAR));
    setPickerOpen(true);
  };

  const selectFromGrid = (year: number) => {
    applyYearValue(year);
    setPickerOpen(false);
  };

  const nextPageDisabled = pageStart >= startOfYearPage(CURRENT_YEAR);
  const prevPageDisabled = pageStart <= startOfYearPage(MIN_YEAR);

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 sm:flex-row sm:items-start sm:gap-4",
        selectedYear && "ring-brand/30"
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-foreground">
        <CalendarDays className="size-4" strokeWidth={2.25} />
      </span>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="year-picker-input" className="text-xs text-muted-foreground">
          {t("label")}
        </Label>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={openPicker}
            aria-label={t("pickAria")}
          >
            <CalendarDays className="size-4" />
          </Button>
          <Input
            id="year-picker-input"
            type="number"
            inputMode="numeric"
            min={MIN_YEAR}
            max={CURRENT_YEAR}
            placeholder={String(CURRENT_YEAR)}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyDraft();
            }}
            className="w-24"
          />
          <button
            type="button"
            onClick={applyDraft}
            className="rounded-lg bg-muted px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {t("view")}
          </button>
        </div>
      </div>

      <div className="min-w-0 flex-1 sm:pt-6">
        {!selectedYear ? (
          <p className="text-sm text-muted-foreground">{t("emptyHint")}</p>
        ) : loading ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("computing", { year: selectedYear })}
          </p>
        ) : summaryError ? (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertCircle className="size-3.5 shrink-0" />
            {summaryError}
          </p>
        ) : summary ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm text-muted-foreground">
              {t.rich("totalLabel", {
                year: selectedYear,
                b: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
              })}
            </p>
            {/* One triplet (gelir/gider/net) PER CURRENCY — TRY always
             * first (per `summarize`'s zero-fill rule), any other currency
             * actually used appended below it as its own independent
             * triplet, never converted/combined with TRY's (design decision
             * #4, approved plan). */}
            {summary.map((entry) => (
              <div key={entry.currency} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="num-tabular text-lg font-semibold text-income">
                  {formatAmount(entry.totalIncome, entry.currency)}
                </span>
                <span className="num-tabular text-lg font-semibold text-destructive">
                  {formatAmount(entry.totalExpense, entry.currency)}
                </span>
                <span className="num-tabular text-sm text-muted-foreground">
                  {t("netLabel", { value: formatAmount(entry.net, entry.currency) })}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {hasActiveFilters ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="sm:mb-1 sm:ml-auto"
        >
          <FilterX className="size-3.5" />
          {t("clearFilter")}
        </Button>
      ) : null}

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
          </DialogHeader>

          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setPageStart((s) => s - YEARS_PER_PAGE)}
              disabled={prevPageDisabled}
              aria-label={t("prevYears")}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="num-tabular text-sm font-medium text-foreground">
              {pageStart} – {pageStart + YEARS_PER_PAGE - 1}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setPageStart((s) => s + YEARS_PER_PAGE)}
              disabled={nextPageDisabled}
              aria-label={t("nextYears")}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>

          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: YEARS_PER_PAGE }, (_, index) => pageStart + index).map((year) => {
              const disabled = year > CURRENT_YEAR || year < MIN_YEAR;
              const active = year === selectedYear;
              return (
                <button
                  key={year}
                  type="button"
                  disabled={disabled}
                  onClick={() => selectFromGrid(year)}
                  className={cn(
                    "num-tabular rounded-lg py-2 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    disabled
                      ? "cursor-not-allowed text-muted-foreground/40"
                      : active
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground hover:bg-muted"
                  )}
                >
                  {year}
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
