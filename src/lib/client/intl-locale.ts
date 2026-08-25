import type { Locale } from "@/i18n/locale";

/**
 * Maps this app's bare `Locale` ("tr"/"en" — see i18n/locale.ts) to a
 * region-qualified BCP 47 tag for `Intl.DateTimeFormat`/`Intl.NumberFormat`
 * call sites throughout the transactions UI (date labels, chart axis
 * ticks, tooltips) — a bare "en" still works with `Intl`, but "en-US"
 * pins the exact grouping/date-order convention this app's English copy is
 * written against, the same way "tr-TR" already was hardcoded everywhere
 * before locale became dynamic. NOT used by `lib/domain/currency`'s
 * `formatAmount` — that stays fixed to "tr-TR" regardless of UI locale (see
 * its own doc comment; shared with the future mobile client, out of this
 * pass's scope).
 */
export function toIntlLocale(locale: Locale): string {
  return locale === "en" ? "en-US" : "tr-TR";
}
