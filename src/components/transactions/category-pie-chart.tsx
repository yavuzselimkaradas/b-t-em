"use client";

import { useMemo } from "react";
import type Decimal from "decimal.js";
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, PieChart as PieChartIcon } from "lucide-react";
import { useLocale } from "next-intl";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip, type TooltipContentProps } from "recharts";

import { cn } from "@/lib/utils";
import type { CategorySlice, PerCurrencyTotal } from "@/lib/domain/transactions/aggregate";
import {
  convertAmount,
  formatAmount,
  type CurrencyCode,
  type ExchangeRateTable,
} from "@/lib/domain/currency";
import { toIntlLocale } from "@/lib/client/intl-locale";
import { useScopedTranslations } from "@/lib/client/use-scoped-translations";
import type { Locale } from "@/i18n/locale";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCategoryChartColor } from "@/components/transactions/category-visual";
import { MultiCurrencyAmount } from "@/components/transactions/multi-currency-amount";

/** Slices past this rank are folded into a single "Diğer" wedge — keeps the
 * chart inside the ~6-class range it stays legible at (past that, adjacent
 * wedges start blurring together, see dataviz skill's form guidance) and
 * incidentally shrinks how often two folded-in categories would otherwise
 * land on the same hashed chip color. A user with 5 or fewer categories of
 * a given type (true for every seed category today) never sees "Diğer" at
 * all. */
const MAX_VISIBLE_SLICES = 5;
/** Neutral gray, deliberately outside `CHIP_HEX` (category-visual.ts) — this
 * wedge isn't a real category, so it must never coincide with one. */
const OTHER_COLOR = "#78716c";

interface ChartSlice {
  key: string;
  label: string;
  /** One line per currency actually behind this slice's amount — the
   * common case is a single-element array (either the category's ORIGINAL
   * un-converted total when every transaction in it used one currency, or
   * the folded "Diğer" row's "≈"-prefixed `baseCurrency` approximation).
   * A category that mixed two or more currencies (`display.kind ===
   * "mixed"`) gets one line PER currency instead of a single merged
   * figure — see `CategorySlice.display`'s doc comment
   * (lib/domain/transactions/aggregate.ts) for why nothing is summed
   * across currencies here. */
  displayLines: string[];
  color: string;
  /** `baseCurrency`-converted amount — drives slice SIZE only, never shown
   * as a label by itself (use `displayLines` for that). */
  amountBase: number;
  percentage: number;
}

/** Formats one native `(currency, amount)` pair as its own display line —
 * plain if it's already in `baseCurrency`, with a "(≈ X)" conversion
 * annotation appended otherwise (same convention `MultiCurrencyAmount` uses
 * for its own secondary rows) so a foreign-currency line is never shown
 * without SOME indication of what it's worth in the currency every other
 * line/slice on this chart is sized against. `rates` absent (still loading,
 * or the fetch failed) just skips the annotation — the native amount alone
 * is still correct, only the parenthetical is unavailable. */
function formatCurrencyLine(
  amount: Decimal.Value,
  currency: CurrencyCode,
  baseCurrency: CurrencyCode,
  rates: ExchangeRateTable | undefined
): string {
  const original = formatAmount(amount, currency);
  if (currency === baseCurrency || !rates) return original;
  return `${original} (≈ ${formatAmount(convertAmount(amount, currency, baseCurrency, rates), baseCurrency)})`;
}

function sliceDisplayLines(
  slice: CategorySlice,
  baseCurrency: CurrencyCode,
  rates: ExchangeRateTable | undefined
): string[] {
  if (slice.display.kind === "single") {
    return [formatCurrencyLine(slice.display.amount, slice.display.currency, baseCurrency, rates)];
  }
  // "mixed": one line per currency (already ordered baseCurrency-first by
  // categoryBreakdown), never merged into a single converted figure.
  return slice.display.amounts.map(({ currency, amount }) =>
    formatCurrencyLine(amount, currency, baseCurrency, rates)
  );
}

function toChartSlices(
  slices: CategorySlice[],
  baseCurrency: CurrencyCode,
  rates: ExchangeRateTable | undefined,
  otherLabel: string
): ChartSlice[] {
  const visible = slices.slice(0, MAX_VISIBLE_SLICES).map((slice) => ({
    key: slice.categoryId,
    label: slice.categoryName,
    displayLines: sliceDisplayLines(slice, baseCurrency, rates),
    color: slice.color || getCategoryChartColor({ id: slice.categoryId }),
    amountBase: slice.amountBase.toNumber(),
    percentage: slice.percentage,
  }));

  const rest = slices.slice(MAX_VISIBLE_SLICES);
  if (rest.length === 0) return visible;

  // "Diğer" folds multiple categories together — there's no single original
  // currency left to show (even if every folded-in category individually
  // used the same one, that coincidence isn't worth detecting here), so this
  // always renders as a single "≈" `baseCurrency` approximation line, same
  // as a genuinely mixed single category's OWN total would (not per-line
  // per-currency, since the currencies here belong to different CATEGORIES,
  // not one category — there's no single category identity left to hang
  // multiple currency lines off of).
  const otherAmountBase = rest.reduce((sum, slice) => sum + slice.amountBase.toNumber(), 0);
  const otherPercentage = rest.reduce((sum, slice) => sum + slice.percentage, 0);
  visible.push({
    key: "__other__",
    label: otherLabel,
    displayLines: [`≈ ${formatAmount(otherAmountBase, baseCurrency)}`],
    color: OTHER_COLOR,
    amountBase: otherAmountBase,
    percentage: otherPercentage,
  });

  return visible;
}

interface CategoryPieChartProps {
  income: CategorySlice[];
  expense: CategorySlice[];
  /** Both panels' header totals — the SAME array feeds both (income panel
   * reads `field="totalIncome"`, expense panel reads `field="totalExpense"`)
   * since `summarize()` (lib/domain/transactions/aggregate.ts) already
   * computes both flows together, per currency, from the same transaction
   * set the caller ran `categoryBreakdown` on — no extra fetch needed. */
  totals: PerCurrencyTotal[];
  /** Current USD/EUR→TRY rates — forwarded to the header total's
   * `MultiCurrencyAmount` so a secondary-currency total also shows its TRY
   * equivalent (same "(≈ ₺X)" annotation `formatSliceAmount` adds to each
   * slice below). Optional/omittable the same way `MultiCurrencyAmount`'s
   * own `rates` prop is. */
  rates?: ExchangeRateTable;
  /** The "ana para birimi" every slice's SIZE and the header total's primary
   * row are computed against — the signed-in user's `User.preferredCurrency`
   * (`getMyPreferredCurrency()`), or `"TRY"` for guests/unresolved callers.
   * Must be the SAME value the caller passed as `categoryBreakdown`'s
   * `baseCurrency` argument when building `income`/`expense` — this prop
   * only affects LABELING (which slice gets a "(≈ ...)" parenthetical,
   * which currency the header/"Diğer" totals are formatted in), the actual
   * conversion math already happened upstream. Defaults to `"TRY"`. */
  baseCurrency?: CurrencyCode;
  /** The İşlemler page's own active date filter (`TransactionFilterState.from`/
   * `.to` — empty string when unset). Forwarded onto the "Gelir dağılımı"/
   * "Gider dağılımı" trend links so the range carries over: a user filtered
   * to 15 Mayıs–30 Haziran here sees that same range on the trend page, not
   * its own unrelated last-7-days default. */
  from?: string;
  to?: string;
  /** Where the "Gelir dağılımı"/"Gider dağılımı" titles link to — defaults
   * to `/transactions/trend` (the individual page's own trend view).
   * `FamilyDashboard` passes `/family/dashboard/trend` instead so the SAME
   * pie chart, rendered in family scope, links to the family-scoped trend
   * view (`FamilyTrendView`) rather than the individual one — added
   * 2026-08-22, fixing a pre-existing gap where the family dashboard's pie
   * chart always linked to the individual page regardless of scope. */
  trendBasePath?: string;
  /** `true` on `/transactions` (tracks the active locale), omitted/`false`
   * on `/family/dashboard` (`FamilyDashboard` passes this same component —
   * out of scope this round, stays pinned to Turkish) — see
   * lib/client/use-scoped-translations.ts's doc comment. */
  translate?: boolean;
}

/**
 * Two independent pie charts — income and expense are never mixed into one
 * (see `categoryBreakdown`'s doc comment) — each with a legend that carries
 * category name, amount, and percentage as static text, not only as a
 * hover tooltip: color marks identity, the legend row is what makes it
 * readable without relying on color perception at all.
 */
export function CategoryPieChart({
  income,
  expense,
  totals,
  rates,
  baseCurrency = "TRY",
  from,
  to,
  trendBasePath,
  translate = false,
}: CategoryPieChartProps) {
  const t = useScopedTranslations("transactions.pieChart", translate);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <CategoryPiePanel
        title={t("incomeTitle")}
        tone="income"
        icon={ArrowUpRight}
        slices={income}
        totals={totals}
        rates={rates}
        baseCurrency={baseCurrency}
        emptyMessage={t("incomeEmpty")}
        from={from}
        to={to}
        trendBasePath={trendBasePath}
        translate={translate}
      />
      <CategoryPiePanel
        title={t("expenseTitle")}
        tone="expense"
        icon={ArrowDownRight}
        slices={expense}
        totals={totals}
        rates={rates}
        baseCurrency={baseCurrency}
        emptyMessage={t("expenseEmpty")}
        from={from}
        to={to}
        trendBasePath={trendBasePath}
        translate={translate}
      />
    </div>
  );
}

function CategoryPiePanel({
  title,
  tone,
  icon: Icon,
  slices,
  totals,
  rates,
  baseCurrency = "TRY",
  emptyMessage,
  from,
  to,
  trendBasePath = "/transactions/trend",
  translate = false,
}: {
  title: string;
  tone: "income" | "expense";
  icon: typeof ArrowUpRight;
  slices: CategorySlice[];
  totals: PerCurrencyTotal[];
  rates?: ExchangeRateTable;
  baseCurrency?: CurrencyCode;
  emptyMessage: string;
  from?: string;
  to?: string;
  trendBasePath?: string;
  translate?: boolean;
}) {
  const t = useScopedTranslations("transactions.pieChart", translate);
  const activeLocale = useLocale() as Locale;
  const percentFormatter = new Intl.NumberFormat(toIntlLocale(translate ? activeLocale : "tr"), {
    maximumFractionDigits: 1,
  });
  const otherLabel = t("other");
  const chartSlices = useMemo(
    () => toChartSlices(slices, baseCurrency, rates, otherLabel),
    [slices, baseCurrency, rates, otherLabel]
  );

  const trendParams = new URLSearchParams({ type: tone === "income" ? "INCOME" : "EXPENSE" });
  if (from) trendParams.set("from", from);
  if (to) trendParams.set("to", to);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 [.border-b]:pb-0">
        <CardTitle className="flex items-center gap-1.5">
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full",
              tone === "income" ? "bg-income-soft text-income" : "bg-destructive/10 text-destructive"
            )}
          >
            <Icon className="size-3.5" strokeWidth={2.5} />
          </span>
          {/* Clicking the title goes to the daily/monthly trend for just this
              flow (income or expense) — a separate page/query since it
              answers a different question ("how is this changing over
              time") than this card's own "what makes it up" breakdown.
              Carries the İşlemler page's own date filter over (`from`/`to`
              above) when one is active, so the trend shows the same range
              instead of resetting to its own last-7-days default. */}
          <Link
            href={`${trendBasePath}?${trendParams.toString()}`}
            className="rounded-sm hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {title}
          </Link>
        </CardTitle>
        {chartSlices.length > 0 ? (
          <MultiCurrencyAmount
            rows={totals}
            field={tone === "income" ? "totalIncome" : "totalExpense"}
            rates={rates}
          />
        ) : null}
      </CardHeader>
      <CardContent>
        {chartSlices.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <PieChartIcon className="size-4" strokeWidth={2} />
            </span>
            <p className="max-w-48 text-sm text-muted-foreground">{emptyMessage}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 sm:flex-row">
            <div className="size-36 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartSlices}
                    dataKey="amountBase"
                    nameKey="label"
                    innerRadius="58%"
                    outerRadius="100%"
                    paddingAngle={chartSlices.length > 1 ? 2 : 0}
                    stroke="var(--card)"
                    strokeWidth={2}
                    isAnimationActive={false}
                  >
                    {chartSlices.map((slice) => (
                      <Cell key={slice.key} fill={slice.color} />
                    ))}
                  </Pie>
                  <Tooltip content={(props) => <SliceTooltip {...props} translate={translate} />} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <ul className="flex w-full min-w-0 flex-1 flex-col gap-2">
              {/* Name + percentage share the top line (compact, matches the
               * pre-multi-currency layout); the amount(s) get their own
               * line(s) underneath instead of forcing the row wider than the
               * card. A mixed-currency category renders MULTIPLE amount
               * lines here (one per currency, never merged) — see
               * `displayLines`'s doc comment. */}
              {chartSlices.map((slice) => (
                <li key={slice.key} className="flex flex-col gap-0.5 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: slice.color }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-foreground">{slice.label}</span>
                    <span className="num-tabular shrink-0 text-muted-foreground">
                      %{percentFormatter.format(slice.percentage)}
                    </span>
                  </div>
                  {slice.displayLines.map((line, index) => (
                    <span
                      key={index}
                      className="num-tabular truncate pl-4.5 text-xs text-muted-foreground"
                    >
                      {line}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SliceTooltip({
  active,
  payload,
  translate = false,
}: TooltipContentProps & { translate?: boolean }) {
  const activeLocale = useLocale() as Locale;
  const percentFormatter = new Intl.NumberFormat(toIntlLocale(translate ? activeLocale : "tr"), {
    maximumFractionDigits: 1,
  });
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const slice = entry.payload as ChartSlice;

  return (
    <div className="rounded-lg bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <p className="flex items-center gap-1.5 font-medium">
        <span className="size-2 rounded-full" style={{ backgroundColor: slice.color }} aria-hidden />
        {slice.label}
      </p>
      <p className="num-tabular mt-0.5 text-muted-foreground">
        {slice.displayLines.join(" + ")} · %{percentFormatter.format(slice.percentage)}
      </p>
    </div>
  );
}
