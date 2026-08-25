// Framework-agnostic aggregation logic for transactions. No Next.js / Prisma
// imports here — this module is shared between the web app
// (src/lib/server/**) and the future mobile client.
import Decimal from "decimal.js";

// Relative import (not the `@/lib/domain` barrel) — `lib/domain/index.ts`
// re-exports THIS module too, so importing the barrel here would be a
// circular import back through itself.
import { convertAmount, type CurrencyCode, type ExchangeRateTable } from "../currency";

/**
 * Mirrors Prisma's `TransactionType` enum values ("INCOME" | "EXPENSE").
 * Duplicated here deliberately, not imported from `@prisma/client` — this
 * layer must stay framework/ORM-independent (see barrel comment in
 * lib/domain/index.ts). If schema.prisma's `TransactionType` enum ever gains
 * a third case, this type — and every switch/if over it in this file — must
 * be updated by hand.
 */
export type TransactionKind = "INCOME" | "EXPENSE";

/**
 * A transaction as seen by domain-layer math. Deliberately narrower than
 * Prisma's `Transaction` model — only the fields aggregation needs.
 *
 * `amount` is typed as `Decimal.Value` (decimal.js's own `string | number |
 * Decimal` union) — NOT Prisma's `Decimal` class. Prisma's `Decimal` and
 * this module's `Decimal` (the `decimal.js` package, an explicit dependency
 * of this project) are two separately bundled copies of the same library;
 * passing a `Prisma.Decimal` instance straight into this module's `Decimal`
 * constructor risks failing an internal `instanceof` check across that
 * boundary. Callers in `lib/server/**` must convert with `.toString()`
 * before building a `TransactionRecord`, e.g.:
 *
 *   const records: TransactionRecord[] = transactions.map((t) => ({
 *     type: t.type,
 *     amount: t.amount.toString(),
 *     currency: t.currency,
 *   }));
 *
 * This keeps the Prisma-Decimal → domain-Decimal conversion at the
 * framework boundary, where it belongs, instead of this module guessing
 * about Prisma internals.
 */
export interface TransactionRecord {
  type: TransactionKind;
  amount: Decimal.Value;
  /** Required — every stored `Transaction` has a `currency` (schema.prisma:
   * `Currency` is a non-nullable column), and `summarize`/`categoryBreakdown`
   * both group by it now (see their doc comments below for why mixing
   * currencies without grouping was a bug, not a simplification). */
  currency: CurrencyCode;
}

export interface TransactionSummary {
  totalIncome: Decimal;
  totalExpense: Decimal;
  net: Decimal;
}

/** One currency's totals from `summarize` — see that function's doc comment
 * for the "TRY always present, others only if there's data, never converted
 * into one another" rule this shape encodes. */
export interface PerCurrencyTotal extends TransactionSummary {
  currency: CurrencyCode;
}

/**
 * Sums a list of transactions into total income, total expense, and net
 * balance (income − expense), SEPARATELY PER CURRENCY — summing a TRY amount
 * and a USD amount into one number is not just imprecise, it's meaningless
 * (they're different units), so this never adds across currencies. Returns
 * one `PerCurrencyTotal` per currency present in `transactions`, PLUS a
 * `baseCurrency` entry ALWAYS (even `{totalIncome: 0, totalExpense: 0, net: 0}`
 * when there's no data in that currency at all) — `baseCurrency` defaults to
 * `"TRY"` (this app's fallback base currency for guests and any caller that
 * hasn't resolved a signed-in user's preference) but a caller may pass the
 * signed-in user's own `User.preferredCurrency` instead, in which case THAT
 * currency is what's guaranteed present and sorted first — see
 * `getMyPreferredCurrency()` (lib/server/actions/currency.ts). Every caller
 * can render `results[0]` unconditionally without a presence check; a
 * non-base currency only appears here if at least one transaction actually
 * used it. `baseCurrency` sorts first, any other currencies present sort
 * alphabetically after it — a stable, deterministic order for rendering.
 *
 * NO currency conversion happens here (contrast with `categoryBreakdown`,
 * which DOES convert — for slice SIZE only, never for these totals; see
 * design decision #4 in the approved plan: "Bu satırlar arasında dönüşüm
 * yok — her para birimi kendi ham toplamıyla ayrı durur"). Pure and
 * synchronous — no DB access, no FX lookup needed.
 *
 * Uses `decimal.js` throughout — never `number`/`Float` — so summing many
 * rows can't accumulate floating-point rounding error, which matters for a
 * financial total.
 */
export function summarize(
  transactions: readonly TransactionRecord[],
  baseCurrency: CurrencyCode = "TRY"
): PerCurrencyTotal[] {
  const totalsByCurrency = new Map<CurrencyCode, { totalIncome: Decimal; totalExpense: Decimal }>();
  // Base currency always present, even with zero transactions — see doc
  // comment above.
  totalsByCurrency.set(baseCurrency, { totalIncome: new Decimal(0), totalExpense: new Decimal(0) });

  for (const transaction of transactions) {
    const amount = new Decimal(transaction.amount);
    const existing = totalsByCurrency.get(transaction.currency) ?? {
      totalIncome: new Decimal(0),
      totalExpense: new Decimal(0),
    };
    if (transaction.type === "INCOME") {
      existing.totalIncome = existing.totalIncome.plus(amount);
    } else {
      existing.totalExpense = existing.totalExpense.plus(amount);
    }
    totalsByCurrency.set(transaction.currency, existing);
  }

  const otherCurrencies = Array.from(totalsByCurrency.keys())
    .filter((currency) => currency !== baseCurrency)
    .sort();
  const orderedCurrencies: CurrencyCode[] = [baseCurrency, ...otherCurrencies];

  return orderedCurrencies.map((currency) => {
    const { totalIncome, totalExpense } = totalsByCurrency.get(currency)!;
    return { currency, totalIncome, totalExpense, net: totalIncome.minus(totalExpense) };
  });
}

/**
 * A transaction as seen by `categoryBreakdown` — `TransactionRecord` plus
 * the category fields the breakdown groups by. Deliberately a separate
 * interface rather than widening `TransactionRecord` itself:
 * `TransactionRecord` is also `summarize`'s input, and today nothing
 * upstream builds one with category data attached, so adding required
 * fields there would be pure churn for every future caller that only wants
 * a total. `color` mirrors `Category.color` (nullable in schema.prisma —
 * every seeded category has it `null` today, see the comment on
 * `getCategoryVisual` in components/transactions/category-visual.ts) and is
 * passed through unchanged, not defaulted here — picking a fallback color
 * is a UI concern, not aggregation.
 */
export interface CategorizedTransactionRecord extends TransactionRecord {
  categoryId: string;
  categoryName: string;
  color?: string | null;
}

/**
 * One slice of a category pie/bar for a single transaction type (income OR
 * expense — see `categoryBreakdown`). `percentage` is 0–100, share of that
 * type's total, not of income+expense combined — see `categoryBreakdown`'s
 * doc comment for exactly how it's computed (converted to the caller's
 * `baseCurrency`, always).
 *
 * `amountBase`: the category's total, CONVERTED to `categoryBreakdown`'s
 * `baseCurrency` argument — this is what drives slice SIZE (`percentage`)
 * and is always safe to sum/compare across categories regardless of what
 * currency each one's transactions were originally in. NEVER shown to the
 * user as a labeled amount by itself if `display.kind === "single"` (show
 * `display.amount`/`display.currency` instead, the original un-converted
 * figure) — only used as-is when `display.kind === "mixed"`, where there is
 * no single "original" amount left to show (see design decision #2/#3 in the
 * approved plan).
 *
 * `display`: what to actually LABEL the slice with.
 *  - `"single"`: every transaction in this category (for this type, in this
 *    result set) used the SAME currency — label with that currency's own,
 *    un-converted total (`amount`/`currency`), not `amountBase`.
 *  - `"mixed"`: the category mixed two or more currencies — there is no
 *    single original amount to show, so the caller labels the slice with
 *    EACH currency's own un-converted total separately (`amounts`, one
 *    entry per currency actually used, `baseCurrency` first if present
 *    then the rest alphabetically — same ordering rule `summarize` uses)
 *    rather than folding them into one converted number. `amountBase` (the
 *    SUM converted to `baseCurrency`) still exists on the slice and still
 *    drives its SIZE, it's just not what gets displayed as text anymore.
 */
export interface CategorySlice {
  categoryId: string;
  categoryName: string;
  color?: string | null;
  amountBase: Decimal;
  percentage: number;
  display:
    | { kind: "single"; amount: Decimal; currency: CurrencyCode }
    | { kind: "mixed"; amounts: { currency: CurrencyCode; amount: Decimal }[] };
}

/**
 * Groups transactions by category, separately for income and expense —
 * summing income and expense categories into one pie would put "Maaş" and
 * "Kira" on the same chart with no shared meaning, which is why this
 * returns two independent slice lists rather than one. Percentages are
 * each type's share of *that type's* `baseCurrency`-converted total (income
 * slices sum to ~100, expense slices sum to ~100 — never mixed across type),
 * so a caller can render two independent, self-contained pies straight from
 * this.
 *
 * Requires `rates` (an `ExchangeRateTable`, e.g. from
 * `getCurrentExchangeRates()`) because slice SIZE always needs a common
 * unit: a category with $10 and a category with ₺10 are not proportionally
 * comparable without converting one to the other's currency first — this
 * function converts every amount to `baseCurrency` (default `"TRY"`, or the
 * signed-in user's own `User.preferredCurrency` when the caller resolved
 * one — see `getMyPreferredCurrency()`) for that purpose. This does NOT mean
 * amounts are silently "converted and hidden" from the user, though — see
 * `CategorySlice.display` above for the rule that keeps a single-currency
 * category's ORIGINAL amount as its label.
 *
 * Slices come back sorted largest-`amountBase`-first (a reasonable default
 * pie order — largest wedge first, clockwise from 12 o'clock) — purely a
 * display convenience, callers are free to re-sort.
 *
 * Same `Decimal` discipline as `summarize`: sums with `decimal.js`
 * throughout, only converts to `number` for the final `percentage`
 * (display-only, not a stored/compared amount).
 */
export function categoryBreakdown(
  transactions: readonly CategorizedTransactionRecord[],
  rates: ExchangeRateTable,
  baseCurrency: CurrencyCode = "TRY"
): { income: CategorySlice[]; expense: CategorySlice[] } {
  return {
    income: breakdownByType(transactions, "INCOME", rates, baseCurrency),
    expense: breakdownByType(transactions, "EXPENSE", rates, baseCurrency),
  };
}

function breakdownByType(
  transactions: readonly CategorizedTransactionRecord[],
  type: TransactionKind,
  rates: ExchangeRateTable,
  baseCurrency: CurrencyCode
): CategorySlice[] {
  const byCategory = new Map<
    string,
    {
      categoryName: string;
      color?: string | null;
      amountBase: Decimal;
      /** Native (un-converted) totals per currency seen for this category —
       * used only to decide `display` below, never for slice size. */
      amountsByCurrency: Map<CurrencyCode, Decimal>;
    }
  >();
  let totalBase = new Decimal(0);

  for (const transaction of transactions) {
    if (transaction.type !== type) continue;

    const amount = new Decimal(transaction.amount);
    const amountBase = convertAmount(amount, transaction.currency, baseCurrency, rates);
    totalBase = totalBase.plus(amountBase);

    const existing = byCategory.get(transaction.categoryId);
    if (existing) {
      existing.amountBase = existing.amountBase.plus(amountBase);
      const nativeSoFar = existing.amountsByCurrency.get(transaction.currency) ?? new Decimal(0);
      existing.amountsByCurrency.set(transaction.currency, nativeSoFar.plus(amount));
    } else {
      byCategory.set(transaction.categoryId, {
        categoryName: transaction.categoryName,
        color: transaction.color,
        amountBase,
        amountsByCurrency: new Map([[transaction.currency, amount]]),
      });
    }
  }

  if (totalBase.isZero()) return [];

  return Array.from(byCategory.entries())
    .map(([categoryId, entry]) => {
      const currencies = Array.from(entry.amountsByCurrency.keys());
      const display: CategorySlice["display"] =
        currencies.length === 1
          ? { kind: "single", amount: entry.amountsByCurrency.get(currencies[0])!, currency: currencies[0] }
          : {
              kind: "mixed",
              amounts: [
                ...(entry.amountsByCurrency.has(baseCurrency)
                  ? [{ currency: baseCurrency, amount: entry.amountsByCurrency.get(baseCurrency)! }]
                  : []),
                ...currencies
                  .filter((currency) => currency !== baseCurrency)
                  .sort()
                  .map((currency) => ({ currency, amount: entry.amountsByCurrency.get(currency)! })),
              ],
            };

      return {
        categoryId,
        categoryName: entry.categoryName,
        color: entry.color,
        amountBase: entry.amountBase,
        percentage: entry.amountBase.dividedBy(totalBase).times(100).toNumber(),
        display,
      };
    })
    .sort((a, b) => b.amountBase.comparedTo(a.amountBase));
}

/**
 * A transaction as seen by `groupByActor` — `TransactionRecord` plus which
 * user it's attributed to. Deliberately a separate interface from
 * `TransactionRecord` for the same reason `CategorizedTransactionRecord` is
 * (see its comment above): `TransactionRecord` is also `summarize`'s input,
 * and widening it would force every caller that only wants a plain total to
 * carry a `userId` it doesn't have.
 */
export interface ActorTransactionRecord extends TransactionRecord {
  userId: string;
}

/**
 * Reduces a flat list of (userId × type × currency) records — e.g. the rows
 * of a `db.transaction.groupBy({ by: ["userId", "type", "currency"], _sum: {
 * amount: true } })` query — into one `PerCurrencyTotal[]` per userId (family
 * member), via `summarize` per actor. Exists for Aşama 3.5's family "who
 * spent/earned how much" breakdown: the DB does the heavy grouping (summing
 * many transaction rows), this just folds the resulting three-dimensional
 * (userId × type × currency) result down to one per-currency breakdown per
 * actor — a small enough step that doing it here (framework-agnostic,
 * unit-testable) beats duplicating a hand-rolled reduction at every call
 * site.
 *
 * PER-CURRENCY, same reasoning as `summarize` (which this delegates to, one
 * call per actor) — a family member's TRY and USD spending are not one
 * number, so this was updated alongside `summarize`'s per-currency rewrite
 * (previously this silently summed different currencies together, the same
 * bug `summarize` had). Every actor's array includes a `"TRY"` entry always
 * (even zero), plus any other currency they actually used — see
 * `summarize`'s doc comment for the exact ordering/zero-fill rule, which
 * applies per-actor here too.
 *
 * Pure and synchronous, same `Decimal` discipline as `summarize`/
 * `categoryBreakdown` — never accumulates through `number`/`Float`.
 */
export function groupByActor(
  records: readonly ActorTransactionRecord[]
): Map<string, PerCurrencyTotal[]> {
  const recordsByActor = new Map<string, ActorTransactionRecord[]>();
  for (const record of records) {
    const list = recordsByActor.get(record.userId);
    if (list) {
      list.push(record);
    } else {
      recordsByActor.set(record.userId, [record]);
    }
  }

  const summaryByActor = new Map<string, PerCurrencyTotal[]>();
  for (const [userId, actorRecords] of recordsByActor) {
    summaryByActor.set(userId, summarize(actorRecords));
  }
  return summaryByActor;
}
