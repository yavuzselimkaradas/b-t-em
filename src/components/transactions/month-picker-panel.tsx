"use client";

import { CalendarRange, FilterX } from "lucide-react";
import { useLocale } from "next-intl";

import { cn } from "@/lib/utils";
import { toIntlLocale } from "@/lib/client/intl-locale";
import { useScopedTranslations } from "@/lib/client/use-scoped-translations";
import type { Locale } from "@/i18n/locale";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  clampToToday,
  toInputValue,
  type TransactionFilterState,
} from "@/components/transactions/transaction-filters-bar";

interface MonthPickerPanelProps {
  filters: TransactionFilterState;
  onChange: (patch: Partial<TransactionFilterState>) => void;
  onClear: () => void;
  /** `true` on `/transactions` (tracks the active locale, including date
   * formatting), omitted/`false` on `/family/dashboard` (stays pinned to
   * Turkish) — see lib/client/use-scoped-translations.ts's doc comment. */
  translate?: boolean;
}

/** "yyyy-mm" for the current month — future-dated filtering is disabled
 * (see lib/validation/transaction.ts's `notFutureDateSchema`), so this
 * panel can't be used to jump to e.g. "Mayıs 2027". */
function currentMonthValue(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Resolves an arbitrary from/to pair to a "yyyy-mm" `<input type="month">`
 * value only when it exactly spans one full calendar month — so this panel
 * shows the picked month as selected, but doesn't claim ownership of a
 * range that came from a different filter (e.g. the day/week presets or a
 * manual date range that happens to land inside one month). For the
 * CURRENT month, `to` is expected clamped to today (see `applyMonth` /
 * `clampToToday`), not the calendar month's actual last day — a past
 * month's `to` is unaffected since clamping is a no-op once it's already
 * before today. */
function currentFilterAsMonthValue(filters: TransactionFilterState): string {
  if (!filters.from || !filters.to) return "";
  const from = new Date(`${filters.from}T00:00:00`);
  const firstOfMonth = new Date(from.getFullYear(), from.getMonth(), 1);
  const lastOfMonth = new Date(from.getFullYear(), from.getMonth() + 1, 0);
  const today = toInputValue(new Date());
  const expectedTo = clampToToday(toInputValue(lastOfMonth), today);
  const isFullMonth = toInputValue(from) === toInputValue(firstOfMonth) && filters.to === expectedTo;
  if (!isFullMonth) return "";
  return `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Standalone panel, rendered below the main filter toolbar, for jumping
 * straight to any specific month (past, current, or future) rather than
 * only "this" day/week/month — e.g. reviewing Mart 2026 while it's
 * currently Ağustos. Applying it just sets the same `from`/`to` the other
 * filters use, so the table and pie chart below react to it identically.
 */
export function MonthPickerPanel({
  filters,
  onChange,
  onClear,
  translate = false,
}: MonthPickerPanelProps) {
  const t = useScopedTranslations("transactions.monthPicker", translate);
  const tFilters = useScopedTranslations("transactions.filters", translate);
  const activeLocale = useLocale() as Locale;
  const monthLabelFormatter = new Intl.DateTimeFormat(toIntlLocale(translate ? activeLocale : "tr"), {
    month: "long",
    year: "numeric",
  });
  // No local draft state needed: unlike a free-typed text/number field, a
  // native `<input type="month">` only ever fires onChange with a complete
  // "yyyy-mm" value (or empty on clear) — never a partial one — so it's
  // safe to stay fully controlled straight off the URL-backed filters.
  const selectedMonth = currentFilterAsMonthValue(filters);
  // Same condition as TransactionFiltersBar's own clear button — any active
  // filter, not just a picked month, so this shortcut works no matter which
  // control (Dönem preset, özel aylık aralık, manuel tarih) set it.
  const hasActiveFilters = Boolean(
    filters.type || filters.categoryId || filters.from || filters.to
  );

  const applyMonth = (value: string) => {
    if (!value) return;
    const [yearStr, monthStr] = value.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr) - 1;
    if (Number.isNaN(year) || Number.isNaN(month)) return;
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const today = toInputValue(new Date());
    onChange({ from: toInputValue(first), to: clampToToday(toInputValue(last), today) });
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 sm:flex-row sm:items-end sm:gap-4",
        selectedMonth && "ring-brand/30"
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-foreground">
        <CalendarRange className="size-4" strokeWidth={2.25} />
      </span>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="month-picker-input" className="text-xs text-muted-foreground">
          {t("label")}
        </Label>
        <Input
          id="month-picker-input"
          type="month"
          className="w-40"
          max={currentMonthValue(new Date())}
          value={selectedMonth}
          onChange={(event) => applyMonth(event.target.value)}
        />
      </div>

      {selectedMonth ? (
        <p className="text-sm text-muted-foreground sm:mb-1.5">
          {t.rich("selectedHint", {
            month: monthLabelFormatter.format(new Date(`${selectedMonth}-01T00:00:00`)),
            b: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
          })}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground sm:mb-1.5">{t("emptyHint")}</p>
      )}

      {hasActiveFilters ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="sm:mb-1 sm:ml-auto"
        >
          <FilterX className="size-3.5" />
          {tFilters("clear")}
        </Button>
      ) : null}
    </div>
  );
}
