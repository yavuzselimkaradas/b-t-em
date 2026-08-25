"use client";

import { useState } from "react";
import { FilterX, Plus } from "lucide-react";
import type { Category } from "@prisma/client";

import { cn } from "@/lib/utils";
import type { CreateCategoryResult } from "@/lib/client/transaction-view-model";
import { useScopedTranslations } from "@/lib/client/use-scoped-translations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CustomMonthlyRangeButton } from "@/components/transactions/custom-monthly-range-button";
import { CreateCategoryDialog } from "@/components/transactions/create-category-dialog";

/** Not a real category — a sentinel `<SelectItem>` value that opens
 * `CreateCategoryDialog` instead of ever being written to `filters.categoryId`
 * (see the `onValueChange` handler below). Shaped nothing like a cuid on
 * purpose, so it can never collide with a real category id. */
const CREATE_CATEGORY_VALUE = "__create_category__";

export type TypeFilterValue = "" | "INCOME" | "EXPENSE";

export interface TransactionFilterState {
  type: TypeFilterValue;
  categoryId: string;
  from: string;
  to: string;
}

type PeriodPreset = "day" | "week" | "month";

/** Local calendar date (not UTC) as "yyyy-mm-dd" — same convention as the
 * date filter inputs below and transaction-form.tsx's `todayInputValue`.
 * Exported for `month-picker-panel.tsx`, which needs the same conversion. */
export function toInputValue(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Caps a "yyyy-mm-dd" bound at today — string comparison sorts correctly
 * for this format, no `Date` parsing needed. Future-dated transactions
 * can't exist (see lib/validation/transaction.ts's future-date restriction),
 * so a period's `to` bound must never reach past today: both because
 * there's nothing to show there, and because `transactionFiltersSchema`'s
 * own future-date cap would otherwise reject the request outright (e.g.
 * clicking "Aylık" mid-month previously asked for `to = ayın son günü`,
 * a future date it would now bounce). */
export function clampToToday(dateInputValue: string, today: string): string {
  return dateInputValue > today ? today : dateInputValue;
}

/** Computes the from/to bounds of the current calendar day/week/month, in
 * the user's local timezone. Week starts Monday (TR convention). `to` is
 * clamped to today (see `clampToToday`) — for a past period this is a
 * no-op (the period's real end is already before today), for the
 * in-progress current period it correctly stops at "so far". */
function getPeriodRange(preset: PeriodPreset): { from: string; to: string } {
  const now = new Date();
  const today = toInputValue(now);

  if (preset === "day") {
    return { from: today, to: today };
  }

  if (preset === "week") {
    const dayOfWeek = now.getDay(); // 0 = Sunday .. 6 = Saturday
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    return { from: toInputValue(monday), to: clampToToday(toInputValue(sunday), today) };
  }

  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: toInputValue(firstOfMonth), to: clampToToday(toInputValue(lastOfMonth), today) };
}

interface TransactionFiltersBarProps {
  categories: Category[];
  filters: TransactionFilterState;
  onChange: (patch: Partial<TransactionFilterState>) => void;
  onClear: () => void;
  /** Either `source.createCategory` (lib/client/transactions-source.ts, the
   * account or guest one) on the individual page, or `(input) =>
   * createCategory(input, familyId)` on the family dashboard — this
   * component only needs the create call itself, not the rest of
   * `TransactionSource` (which the family dashboard has no equivalent of;
   * see `TransactionSource`'s own doc comment). */
  onCreateCategory: (input: unknown) => Promise<CreateCategoryResult>;
  /** Called after a category is successfully created, so the parent
   * (`TransactionsView`) can add it to the `categories` list it owns and
   * passes down here — this component never holds that list itself. */
  onCategoryCreated: (category: Category) => void;
  /** `true` on `/transactions` (tracks the active locale), omitted/`false`
   * on `/family/dashboard` (`FamilyDashboard` — out of scope this round,
   * stays pinned to Turkish) — this component and its nested
   * `CustomMonthlyRangeButton`/`CreateCategoryDialog` are the exact same
   * ones both pages render. See lib/client/use-scoped-translations.ts's
   * doc comment. */
  translate?: boolean;
}

/**
 * Compact filter toolbar for the transaction list — quick day/week/month
 * period presets, a button opening the named "kişiselleştirilmiş aylık
 * aralık" preset manager (see `CustomMonthlyRangeButton`), type, category
 * (with a "+ Yeni kategori ekle" entry that opens `CreateCategoryDialog`),
 * and a manual date range. Wraps to multiple lines on narrow screens rather
 * than scrolling. Controlled entirely by the parent (`TransactionsView`),
 * which is the one that keeps this state in the URL.
 */
export function TransactionFiltersBar({
  categories,
  filters,
  onChange,
  onClear,
  onCreateCategory,
  onCategoryCreated,
  translate = false,
}: TransactionFiltersBarProps) {
  const t = useScopedTranslations("transactions.filters", translate);
  const TYPE_OPTIONS: { value: TypeFilterValue; label: string }[] = [
    { value: "", label: t("all") },
    { value: "INCOME", label: t("income") },
    { value: "EXPENSE", label: t("expense") },
  ];
  const PERIOD_OPTIONS: { value: PeriodPreset; label: string }[] = [
    { value: "day", label: t("day") },
    { value: "week", label: t("week") },
    { value: "month", label: t("month") },
  ];

  const categoriesForType = filters.type
    ? categories.filter((category) => category.type === filters.type)
    : categories;
  const hasActiveFilters = Boolean(
    filters.type || filters.categoryId || filters.from || filters.to
  );
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false);

  // Future-dated filtering is disabled (product decision — see
  // lib/validation/transaction.ts's `notFutureDateSchema`), so both manual
  // date inputs are capped at today. Kept in local scope (not exported)
  // since it's re-derived per render, not a stable filter-shape convention
  // like the schema-level check.
  const today = toInputValue(new Date());

  const activePeriod = PERIOD_OPTIONS.find((option) => {
    const range = getPeriodRange(option.value);
    return filters.from === range.from && filters.to === range.to;
  })?.value;

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 sm:flex-row sm:flex-wrap sm:items-end">
      <div className="flex flex-col gap-1.5">
        <Label id="period-filter-label" className="text-xs text-muted-foreground">
          {t("periodLabel")}
        </Label>
        <div
          role="radiogroup"
          aria-labelledby="period-filter-label"
          className="inline-flex w-fit rounded-lg bg-muted p-0.5"
        >
          {PERIOD_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={activePeriod === option.value}
              onClick={() => onChange(getPeriodRange(option.value))}
              className={cn(
                "rounded-[7px] px-2.5 py-1 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                activePeriod === option.value
                  ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">{t("customRangeLabel")}</Label>
        <CustomMonthlyRangeButton filters={filters} onChange={onChange} translate={translate} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label id="type-filter-label" className="text-xs text-muted-foreground">
          {t("typeLabel")}
        </Label>
        <div
          role="radiogroup"
          aria-labelledby="type-filter-label"
          className="inline-flex w-fit rounded-lg bg-muted p-0.5"
        >
          {TYPE_OPTIONS.map((option) => (
            <button
              key={option.value || "all"}
              type="button"
              role="radio"
              aria-checked={filters.type === option.value}
              onClick={() => {
                onChange({ type: option.value });
                // Clear a now-mismatched category rather than leaving a
                // silently-inconsistent filter combo (e.g. "Gelir" + a
                // gider category, which would just return zero results
                // with no explanation).
                const stillValid =
                  !filters.categoryId ||
                  !option.value ||
                  categories.some(
                    (c) => c.id === filters.categoryId && c.type === option.value
                  );
                if (!stillValid) onChange({ categoryId: "" });
              }}
              className={cn(
                "rounded-[7px] px-2.5 py-1 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                filters.type === option.value
                  ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="category-filter" className="text-xs text-muted-foreground">
          {t("categoryLabel")}
        </Label>
        <Select
          value={filters.categoryId || "all"}
          onValueChange={(value) => {
            // The sentinel opens the create dialog instead of ever being
            // written to `filters.categoryId` — the Select stays showing
            // whatever the real filter value already was, since `onChange`
            // is deliberately not called for this branch.
            if (value === CREATE_CATEGORY_VALUE) {
              setCreateCategoryOpen(true);
              return;
            }
            onChange({ categoryId: value && value !== "all" ? value : "" });
          }}
        >
          <SelectTrigger id="category-filter" className="w-44">
            {/* Base UI's <Select.Value> otherwise shows the raw stored
                value (here, the literal string "all") until the popup has
                been opened at least once — this render-prop resolves the
                label up front instead. */}
            <SelectValue placeholder={t("allCategories")}>
              {(value: string) =>
                value === "all"
                  ? t("allCategories")
                  : (categories.find((c) => c.id === value)?.name ?? t("allCategories"))
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allCategories")}</SelectItem>
            {categoriesForType.map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={CREATE_CATEGORY_VALUE}>
              <span className="flex items-center gap-1.5 text-foreground">
                <Plus className="size-3.5" />
                {t("addNewCategory")}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <CreateCategoryDialog
        open={createCategoryOpen}
        onOpenChange={setCreateCategoryOpen}
        onCreate={onCreateCategory}
        translate={translate}
        onCreated={(category) => {
          onCategoryCreated(category);
          // Also apply it as the active filter right away — the user just
          // made it specifically to use it, most likely to filter by it now.
          onChange({ categoryId: category.id, type: category.type });
        }}
        defaultType={filters.type || "EXPENSE"}
      />

      {/* `w-full` forces this pair onto its own row within the parent's
          flex-wrap layout, so "Başlangıç"/"Bitiş" always sit together on
          their own line below Dönem/Kişiselleştirilmiş aralık/Tür/Kategori,
          instead of wherever they happen to land as the row wraps. */}
      <div className="flex w-full flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="from-filter" className="text-xs text-muted-foreground">
            {t("from")}
          </Label>
          <Input
            id="from-filter"
            type="date"
            className="w-36"
            value={filters.from}
            max={filters.to && filters.to < today ? filters.to : today}
            onChange={(event) => onChange({ from: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="to-filter" className="text-xs text-muted-foreground">
            {t("to")}
          </Label>
          <Input
            id="to-filter"
            type="date"
            className="w-36"
            value={filters.to}
            min={filters.from || undefined}
            max={today}
            onChange={(event) => onChange({ to: event.target.value })}
          />
        </div>

        {hasActiveFilters ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClear} className="sm:ml-auto">
            <FilterX className="size-3.5" />
            {t("clear")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
