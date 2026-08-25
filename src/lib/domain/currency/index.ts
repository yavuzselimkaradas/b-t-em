// Framework-agnostic currency logic (formatting, localized-input parsing).
// No Next.js / Prisma imports here — this module is shared between the web
// app (src/lib/server/**, src/app/**) and the future mobile client.
import Decimal from "decimal.js";

/** Mirrors Prisma's `Currency` enum values. Duplicated deliberately — see
 * the same note on `TransactionKind` in lib/domain/transactions/aggregate.ts
 * for why this layer never imports `@prisma/client`. */
export type CurrencyCode = "TRY" | "USD" | "EUR";

/** Every `CurrencyCode` except the app's base currency — the shape of a
 * "how many TRY per 1 of this" rate table, and of `ExchangeRateTable.rates`
 * below. `TRY` is deliberately excluded: there is no "TRY→TRY rate" to
 * store, `convertAmount`'s `from === to` shortcut handles that case without
 * ever consulting the table. */
export type ForeignCurrencyCode = Exclude<CurrencyCode, "TRY">;

/** Maps a `CurrencyCode` to its display symbol — used wherever a compact
 * (non-`Intl.NumberFormat`) amount needs a currency mark, e.g. a pie-chart
 * legend showing an original (unconverted) per-category total. */
const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  TRY: "₺",
  USD: "$",
  EUR: "€",
};

export function getCurrencySymbol(currency: CurrencyCode): string {
  return CURRENCY_SYMBOLS[currency];
}

/**
 * A snapshot of "how many TRY does 1 unit of this foreign currency buy right
 * now" — the shape `getExchangeRates`/`getCurrentExchangeRates`
 * (lib/server/fx/rates.ts / lib/server/actions/currency.ts) hand back to
 * `convertAmount` below. Deliberately does NOT carry a `TRY` key (see
 * `ForeignCurrencyCode`'s comment) — TRY is always the conversion target in
 * this app (Aşama: pasta grafiği kur bazlı büyüklük), never a rate lookup.
 */
export interface ExchangeRateTable {
  rates: Record<ForeignCurrencyCode, Decimal.Value>;
}

/**
 * Converts `amount` from currency `from` to currency `to` using `rates` (a
 * TRY-per-foreign-currency table — see `ExchangeRateTable`). Pure, no I/O:
 * the caller (a Server Action / server component) is responsible for
 * fetching `rates` first (`getCurrentExchangeRates`) and handing it in here.
 *
 * Supports exactly the two directions this app ever needs — foreign→TRY (the
 * category-pie slice-size use case) and TRY→foreign (the inverse, for
 * symmetry/future use) — by going through TRY as the pivot currency in both
 * cases; converting foreign→foreign (e.g. USD→EUR) is not a case this app
 * currently has, but is handled correctly here anyway (divide out `from`'s
 * TRY rate, multiply by `to`'s), since the pivot-through-TRY math already
 * generalizes to it for free.
 *
 * `from === to` is a pure shortcut (returns `amount` unchanged, as a
 * `Decimal`) — deliberately checked BEFORE touching `rates`, so a same-
 * currency amount converts correctly even if `rates` is empty/stale/missing
 * an entry it would otherwise need.
 */
export function convertAmount(
  amount: Decimal.Value,
  from: CurrencyCode,
  to: CurrencyCode,
  rates: ExchangeRateTable
): Decimal {
  const value = new Decimal(amount);
  if (from === to) {
    return value;
  }

  const tryAmount = from === "TRY" ? value : value.times(rates.rates[from as ForeignCurrencyCode]);
  if (to === "TRY") {
    return tryAmount;
  }
  return tryAmount.dividedBy(rates.rates[to as ForeignCurrencyCode]);
}

/**
 * Centralized `{ value, label }` list for every `<select>`/combobox that
 * lets a user pick a `CurrencyCode` (transaction form, family transaction
 * form, budget form, preferences form) — previously copy-pasted verbatim in
 * all four, now defined once here. Label text is UNCHANGED from those four
 * copies (same "CODE — Turkish name (symbol)" wording), so switching a
 * caller over to this constant is a pure refactor with no visible UI change.
 */
export const CURRENCY_OPTIONS: { value: CurrencyCode; label: string }[] = [
  { value: "TRY", label: "TRY — Türk Lirası (₺)" },
  { value: "USD", label: "USD — Amerikan Doları ($)" },
  { value: "EUR", label: "EUR — Euro (€)" },
];

/**
 * Formats an amount as a currency string for display, e.g. `formatAmount("32000", "TRY")`
 * → `"₺32.000,00"`. Locale is fixed to `tr-TR` regardless of `currency` —
 * this app is Turkish-only until i18n lands (Aşama 9); `Intl.NumberFormat`
 * still renders the correct symbol/currency code for USD/EUR while keeping
 * Turkish grouping/decimal punctuation.
 *
 * Takes `Decimal.Value` (string | number | Decimal) and converts to `number`
 * only at the very last step, purely for `Intl.NumberFormat` — this is
 * display-only formatting, not arithmetic, so it doesn't reintroduce the
 * floating-point risk the "always Decimal, never Float" rule (CLAUDE.md)
 * guards against for stored/computed amounts.
 */
export function formatAmount(amount: Decimal.Value, currency: CurrencyCode): string {
  const value = new Decimal(amount).toNumber();
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Normalizes a user-typed amount string into the canonical dot-decimal shape
 * the `amountSchema` in lib/validation/transaction.ts expects (at most 2
 * fraction digits, dot separator). Turkish keyboards default to a comma as
 * the decimal separator, but users just as often type a dot out of habit —
 * this accepts either, heuristically:
 *
 *  - both "," and "." present  → "." is a thousands separator, "," is the
 *    decimal separator (Turkish grouping, e.g. "1.234,56" → "1234.56")
 *  - only ","                  → "," is the decimal separator ("1234,56" → "1234.56")
 *  - only "." or neither       → already canonical, left as-is (and if it's
 *    actually malformed, `amountSchema`'s regex reports a clear error —
 *    this function's job is normalization, not validation)
 */
export function parseLocalizedAmount(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return trimmed;

  const hasComma = trimmed.includes(",");
  const hasDot = trimmed.includes(".");

  if (hasComma && hasDot) {
    return trimmed.replace(/\./g, "").replace(",", ".");
  }
  if (hasComma) {
    return trimmed.replace(",", ".");
  }
  return trimmed;
}
