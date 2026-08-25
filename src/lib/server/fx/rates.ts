import "server-only";

import type { ForeignCurrencyCode } from "@/lib/domain/currency";

// Roadmap "Çoklu Para Birimi — Kur Bazlı Pasta Grafiği" (approved plan,
// design decision #1): "Ücretsiz, anahtarsız dış servis, sunucuda ~1 saat
// cache'lenir. Ağ hatasında son bilinen kur / sabit fallback kullanılır."
//
// Source: Frankfurter (https://frankfurter.dev), a free, keyless, ECB-backed
// FX rate API. NOTE the `.dev` TLD, not `.app` — `api.frankfurter.app` now
// 301-redirects to `api.frankfurter.dev` (verified via WebFetch while
// planning this feature, 2026-08-21); calling `.dev` directly avoids a
// pointless extra hop on every cache-miss request. Real response shape for
// `GET https://api.frankfurter.dev/v1/latest?from=USD&to=TRY`:
//   { "amount": 1.0, "base": "USD", "date": "2026-08-21", "rates": { "TRY": 48.066 } }
//
// This module NEVER throws out of `getExchangeRates` — every caller
// (`getCurrentExchangeRates` Server Action, and transitively every page that
// renders a currency-aware pie chart or net total) must be able to render
// even when Frankfurter is fully unreachable and this server has never
// successfully fetched a rate before. See `FALLBACK_RATES` below.

export interface ExchangeRates {
  /** The date Frankfurter reports the rates as being current for
   * (`"yyyy-mm-dd"`), OR — only when `stale: true` and there has NEVER been a
   * successful fetch in this server process — today's date, purely so the
   * shape is always populated with something displayable. */
  asOf: string;
  /** TRY-per-1-unit for each foreign currency, as decimal strings (never a
   * `number` — same "Decimal everywhere" discipline as every other money
   * value in this codebase, even though an FX rate isn't itself stored
   * currency, it directly multiplies one). Feed straight into
   * `ExchangeRateTable.rates` (lib/domain/currency). */
  rates: Record<ForeignCurrencyCode, string>;
  /** `true` when this is NOT a fresh Frankfurter response — either the
   * last known in-memory rate (network failed, but we've fetched
   * successfully before in this process) or the hardcoded
   * `FALLBACK_RATES` (network failed AND we've never fetched successfully).
   * Callers may use this to show a subtle "kur güncel olmayabilir" hint;
   * it must never block rendering. */
  stale: boolean;
}

/**
 * Rough, deliberately approximate constants — ONLY used when Frankfurter is
 * completely unreachable AND this server process has no `memoryCache` yet
 * (e.g. right after a cold deploy start with the FX host down). Good enough
 * to keep amount-based UI (pie chart slice sizing, mixed-currency category
 * totals) roughly proportionate rather than crashing or showing nothing;
 * NOT good enough to rely on for anything precise — always paired with
 * `stale: true` so the caller can say so.
 */
const FALLBACK_RATES: Record<ForeignCurrencyCode, string> = {
  USD: "42",
  EUR: "45",
};

interface FrankfurterLatestResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

/**
 * Module-level in-memory cache — survives across requests within the same
 * server process (same lifetime/reset semantics as `globalThis.__prisma` in
 * lib/server/db.ts, though this doesn't need the dev-hot-reload `globalThis`
 * trick since staleness here is harmless, unlike a duplicated connection
 * pool). Serves two purposes:
 *  1. Avoids hitting Frankfurter on every request even within the same
 *     `revalidate: 3600` window (`fetch`'s Next.js cache already mostly
 *     covers this, but this is a second, cheaper layer with no I/O at all).
 *  2. Last-known-good fallback: if a later fetch fails (network blip,
 *     Frankfurter down), we still have SOMETHING better than the hardcoded
 *     `FALLBACK_RATES` to serve, marked `stale: true`.
 */
let memoryCache: { asOf: string; rates: Record<ForeignCurrencyCode, string> } | null = null;

/** Fetches "1 `foreign` = how many TRY" from Frankfurter for a single
 * foreign currency. Throws on any failure (non-OK response, malformed body,
 * missing/non-finite rate) — callers (`getExchangeRates`) are responsible
 * for catching and falling back; this function itself has no fallback
 * logic, keeping it a small, honest "fetch or throw" unit. */
async function fetchRateFromTry(foreign: ForeignCurrencyCode): Promise<{ rate: string; date: string }> {
  const response = await fetch(`https://api.frankfurter.dev/v1/latest?from=${foreign}&to=TRY`, {
    next: { revalidate: 3600 },
  });
  if (!response.ok) {
    throw new Error(`Frankfurter request failed for ${foreign}: HTTP ${response.status}`);
  }

  const data = (await response.json()) as FrankfurterLatestResponse;
  const rate = data.rates?.TRY;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Frankfurter response missing a usable TRY rate for ${foreign}`);
  }

  return { rate: rate.toString(), date: data.date };
}

/**
 * Server Action-agnostic (plain async function, no `"use server"` here —
 * that directive lives on the thin wrapper in
 * lib/server/actions/currency.ts) fetch of current USD/EUR→TRY rates.
 *
 * Fetches BOTH currencies in parallel (`Promise.all`, one network round-trip
 * pair, not sequential). `next: { revalidate: 3600 }` lets Next.js's own
 * fetch cache dedupe/reuse this across requests within the hour on top of
 * `memoryCache`.
 *
 * NEVER throws — every failure path (partial or total) is caught and
 * resolved to a best-effort `ExchangeRates`:
 *  - Success: fresh rates, `stale: false`, and `memoryCache` is updated.
 *  - Failure with a prior successful fetch in this process: `memoryCache`'s
 *    last known rates, `stale: true`.
 *  - Failure with NO prior successful fetch: hardcoded `FALLBACK_RATES`,
 *    `stale: true`, `asOf` set to today (nothing more meaningful to report).
 * This guarantees the page this feeds (category pie / net total) can never
 * "crash on FX" — see the approved plan's scenario 4: "FX endpoint
 * erişilemezken sayfa yine de hatasız render oluyor (fallback kur)."
 */
export async function getExchangeRates(): Promise<ExchangeRates> {
  try {
    const [usd, eur] = await Promise.all([fetchRateFromTry("USD"), fetchRateFromTry("EUR")]);
    const rates: Record<ForeignCurrencyCode, string> = { USD: usd.rate, EUR: eur.rate };
    // Both calls report Frankfurter's "latest" date, which is the same
    // banking day for both currencies in practice; USD's is used as the
    // single `asOf` value rather than trying to reconcile two dates that
    // should never actually differ.
    memoryCache = { asOf: usd.date, rates };
    return { asOf: usd.date, rates, stale: false };
  } catch (error) {
    // Logged, not swallowed silently — see CLAUDE.md/backend-developer
    // skill's "errors are informative, not leaky" rule; this is a server
    // log, never surfaced to the client beyond the `stale` flag.
    console.error("getExchangeRates: Frankfurter fetch failed, using fallback", error);

    if (memoryCache) {
      return { asOf: memoryCache.asOf, rates: memoryCache.rates, stale: true };
    }

    return {
      asOf: new Date().toISOString().slice(0, 10),
      rates: FALLBACK_RATES,
      stale: true,
    };
  }
}
