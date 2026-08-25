"use client";

import { createTranslator, useTranslations } from "next-intl";

import trMessages from "@/messages/tr.json";

/**
 * Returns a translator for `namespace` that follows the ACTIVE locale when
 * `translate` is true, but stays pinned to Turkish regardless of the active
 * locale when it's false.
 *
 * Several transaction/budget components are reused verbatim by BOTH an
 * in-scope individual page (`/transactions`, `/budgets` — this i18n pass
 * translates these) and an out-of-scope family page (`/family/dashboard`,
 * `/family/budgets` — see CLAUDE.md's "Aile planı bu turda KAPSAM DIŞI"
 * note, which must keep rendering in Turkish, unchanged, this round):
 * `TransactionFiltersBar`, `CustomMonthlyRangeButton`, `CreateCategoryDialog`,
 * `MonthPickerPanel`, `YearPickerPanel`, `NetTotalCard`, `CategoryPieChart`,
 * `ExportButtons` (transactions) and `BudgetList`/`BudgetRowCard`/
 * `BudgetFormDialog`/`DeleteBudgetDialog` (budgets).
 *
 * Every one of those components takes a `translate` prop (default `false`)
 * for exactly this reason: the individual page (owned by this pass) passes
 * `translate` explicitly; the family page (untouched this round) doesn't,
 * so it silently keeps getting the Turkish-pinned translator — the family
 * page never needs to change for this to keep working. `createTranslator`
 * (next-intl's context-free translator factory — the same one
 * `next-intl/server`'s `getTranslations` uses internally) is what makes a
 * Turkish-pinned instance possible outside of, and regardless of, the
 * ambient `NextIntlClientProvider` locale.
 */
export function useScopedTranslations(namespace: string, translate: boolean) {
  // Always called (rules of hooks) — cheap either way, only one of the two
  // is actually used per render.
  const live = useTranslations(namespace);
  // `namespace` is intentionally a dynamic runtime string here (every call
  // site passes a literal, but this hook itself is namespace-agnostic) —
  // next-intl's own types otherwise narrow `messages`/`namespace` together
  // into a literal union inferred from the imported JSON, which a plain
  // `string` parameter can never satisfy. `as never` opts out of that
  // narrowing for this one generic call the same way `getTranslations`
  // callers elsewhere in this app already do implicitly (no message-type
  // augmentation is configured — see next-intl's docs on `AppConfig`).
  const pinnedTurkish = createTranslator({
    locale: "tr",
    messages: trMessages,
    namespace: namespace as never,
  });
  return translate ? live : pinnedTurkish;
}
