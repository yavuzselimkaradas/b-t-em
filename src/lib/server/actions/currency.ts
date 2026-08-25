"use server";

import { getExchangeRates, type ExchangeRates } from "@/lib/server/fx/rates";
import { auth } from "@/lib/server/auth";
import { db } from "@/lib/server/db";
import type { CurrencyCode } from "@/lib/domain/currency";

// No `auth()` call anywhere in this file, DELIBERATELY — unlike every other
// action module in lib/server/actions/**, exchange rates are not
// user-scoped data. CLAUDE.md's "Misafir modu" rule: the app must work
// without an account, and a guest's category pie chart / net total needs
// FX conversion exactly as much as a signed-in user's does (guest data
// lives in `lib/client/guest-store.ts`, entirely client-side, but still
// carries a `currency` per transaction the same as the DB does). Gating
// this behind a session would silently break the pie chart for every guest
// with mixed-currency data — so this stays open to any caller, same as a
// public read-only endpoint.

export type CurrentExchangeRatesResult =
  | { success: true; data: ExchangeRates }
  | { success: false; error: string };

/**
 * Server Action: current USD/EUR→TRY exchange rates for client-side currency
 * conversion (category pie chart slice sizing — see
 * `categoryBreakdown(transactions, rates)` in
 * lib/domain/transactions/aggregate.ts, which this action's `data` feeds
 * directly as `ExchangeRateTable.rates`).
 *
 * Contract (relied on by frontend-developer / mobile-developer):
 *  - No input, no auth required (see file banner comment above).
 *  - `getExchangeRates()` (lib/server/fx/rates.ts) itself never throws —
 *    it always resolves to a best-effort `ExchangeRates`, falling back to
 *    the last known rate or a hardcoded constant on any network failure,
 *    with `stale: true` marking either fallback path. The `try/catch` here
 *    is therefore defense-in-depth (e.g. an unexpected error constructing
 *    the response), not the primary fallback mechanism — a caller should
 *    still expect `{ success: true }` in the overwhelming majority of
 *    real-world failure modes (network down, Frankfurter down), NOT
 *    `{ success: false }`; treat `data.stale` as the "something's off"
 *    signal, not this action's `success` field.
 *  - Output: `CurrentExchangeRatesResult`. On success, `data` is
 *    `{ asOf: string; rates: { USD: string; EUR: string }; stale: boolean }`.
 */
export async function getCurrentExchangeRates(): Promise<CurrentExchangeRatesResult> {
  try {
    const data = await getExchangeRates();
    return { success: true, data };
  } catch (error) {
    console.error("getCurrentExchangeRates: unexpected failure", error);
    return { success: false, error: "Döviz kurları şu anda alınamıyor." };
  }
}

export type PreferredCurrencyResult =
  | { success: true; data: CurrencyCode }
  | { success: false; error: string };

/**
 * Server Action: the signed-in user's `User.preferredCurrency` — the "ana
 * para birimi" that `TransactionsView`/`FamilyDashboard` resolve once
 * (alongside `getCurrentExchangeRates()`) and thread through as
 * `categoryBreakdown`/`summarize`'s `baseCurrency` argument, so the pie
 * chart sizes itself against this currency and the Net card/pie header show
 * it as the primary row — see `MyProfile`/`getMyProfile` (settings.ts) for
 * the same field read alongside the rest of the profile; this is a narrow,
 * single-field wrapper because the transactions/family-dashboard call sites
 * only ever need this one value, not the whole profile.
 *
 * Unlike `getCurrentExchangeRates`, THIS one requires a session — a guest
 * has no `User` row / persisted preference at all (CLAUDE.md "Misafir
 * modu" — `/settings` itself is an account-only page). Callers on the
 * individual page go through `TransactionSource.getPreferredCurrency`
 * (lib/client/transactions-source.ts), whose guest implementation resolves
 * to `"TRY"` directly without calling this action at all.
 */
export async function getMyPreferredCurrency(): Promise<PreferredCurrencyResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Bu işlem için giriş yapmanız gerekiyor." };
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { preferredCurrency: true },
  });
  if (!user) {
    return { success: false, error: "Bu işlem için giriş yapmanız gerekiyor." };
  }

  return { success: true, data: user.preferredCurrency };
}
