import type Decimal from "decimal.js";

import { cn } from "@/lib/utils";
import { convertAmount, formatAmount, type CurrencyCode, type ExchangeRateTable } from "@/lib/domain/currency";

/**
 * The minimal shape this component needs from one currency's row — a
 * structural subset of BOTH `PerCurrencyTotal` (lib/domain/transactions/aggregate.ts,
 * `Decimal` amounts) and `PerCurrencySummaryData` (lib/server/actions/transactions.ts
 * / lib/client/transaction-view-model.ts, `string` amounts) — `formatAmount`
 * already accepts `Decimal.Value` (`string | number | Decimal`), so either
 * shape works here unchanged, no mapping needed at the call site.
 */
interface MultiCurrencyRow {
  currency: CurrencyCode;
  totalIncome: Decimal.Value;
  totalExpense: Decimal.Value;
  net: Decimal.Value;
}

type Field = "net" | "totalIncome" | "totalExpense";

/** Sign-dependent tone for "net" (positive → income green, negative →
 * destructive red, exactly zero → neutral) — fixed tone for income/expense,
 * matching the tokens every other income/expense figure in this app uses. */
function toneFor(field: Field, numericValue: number): string {
  if (field === "totalIncome") return "text-income";
  if (field === "totalExpense") return "text-destructive";
  if (numericValue > 0) return "text-income";
  if (numericValue < 0) return "text-destructive";
  return "text-muted-foreground";
}

/**
 * Renders one currency's `field` amount per row — `rows[0]` (whatever
 * `summarize()`'s `baseCurrency` argument resolved to: the signed-in user's
 * `preferredCurrency`, or `"TRY"` for guests/unresolved callers) ALWAYS
 * first, even a `0` total, any other currency actually present in `rows`
 * as an additional, visually SECONDARY row underneath. This component takes
 * `rows` as already-ordered and never reorders them itself — it just treats
 * index 0 as "primary" and everything else as "secondary". Deliberately
 * never SUMS rows into each other — each currency's own figure stays its
 * own figure, never folded into the primary row's (design decision #4,
 * approved plan). When `rates` is passed, a secondary row additionally
 * shows a "(≈ {primary currency}X)" parenthetical next to its native amount
 * — informational only, purely a rendering annotation of that ONE row's own
 * value, converted to whatever `rows[0]`'s currency is; it still never
 * touches the primary row or the underlying data.
 *
 * Shared by `NetTotalCard` (`field="net"`, `size="lg"`) and
 * `CategoryPiePanel`'s header total (`field` matching that panel's
 * income/expense tone, `size="default"`) — both need exactly ONE field
 * stacked across currencies. `YearPickerPanel` does NOT use this: it shows
 * all THREE fields (income/expense/net) side by side for a single currency,
 * repeated once per currency row — a different layout shape this
 * single-field component doesn't fit, so that panel builds its own
 * per-currency triplet directly with `formatAmount` instead.
 */
export function MultiCurrencyAmount({
  rows,
  field,
  size = "default",
  rates,
}: {
  rows: MultiCurrencyRow[];
  field: Field;
  /** "lg": primary (TRY) row at `text-2xl` — `NetTotalCard`'s standalone
   * centered figure. "default": primary row at `text-xl` — a panel header
   * total sitting next to a title. "sm": every row (including the primary)
   * at the smaller secondary size. */
  size?: "lg" | "default" | "sm";
  /** Current USD/EUR→TRY rates (`getCurrentExchangeRates`) — when given, a
   * secondary row also shows its equivalent in the PRIMARY row's currency,
   * in parentheses (e.g. primary=USD: "₺3.701,08 (≈ $77,00)"). Optional: a
   * caller with no rates handy (or a page where the approximation isn't
   * relevant) can simply omit it to fall back to the original "amount only"
   * rendering. */
  rates?: ExchangeRateTable;
}) {
  if (rows.length === 0) return null;
  const [primary, ...rest] = rows;

  return (
    <div className="flex flex-col items-end gap-0.5">
      <Row
        row={primary}
        field={field}
        className={cn(
          "num-tabular font-semibold",
          size === "lg" ? "text-2xl" : size === "default" ? "text-xl" : "text-sm"
        )}
      />
      {/* Secondary currencies: smaller, lighter weight than the primary row
       * (the "küçük/muted" demotion the design calls for) — but STILL
       * tone-colored via `toneFor` below, not literally `text-muted-foreground`:
       * losing the income/expense color here would undercut CLAUDE.md §8's
       * "renk körlüğü için ikon desteğini de ekle" rule at the one place
       * these rows are ever shown without an accompanying icon. */}
      {rest.map((row) => (
        <Row
          key={row.currency}
          row={row}
          field={field}
          className="num-tabular text-xs font-medium opacity-80"
          rates={rates}
          convertTo={primary.currency}
        />
      ))}
    </div>
  );
}

function Row({
  row,
  field,
  className,
  rates,
  convertTo,
}: {
  row: MultiCurrencyRow;
  field: Field;
  className: string;
  rates?: ExchangeRateTable;
  /** The primary row's currency — passed only for secondary rows (the
   * primary row itself never gets a "(≈ ...)" annotation, it already IS the
   * reference figure). */
  convertTo?: CurrencyCode;
}) {
  const raw = row[field];
  const approx =
    rates && convertTo && row.currency !== convertTo ? convertAmount(raw, row.currency, convertTo, rates) : null;
  return (
    <span className={cn(className, toneFor(field, Number(raw)))}>
      {formatAmount(raw, row.currency)}
      {approx ? <span className="opacity-70"> (≈ {formatAmount(approx, convertTo!)})</span> : null}
    </span>
  );
}
