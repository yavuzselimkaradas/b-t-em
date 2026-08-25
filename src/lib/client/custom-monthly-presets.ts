/**
 * "Kişiselleştirilmiş aylık aralık" — user-defined, named, recurring
 * monthly filter presets anchored to a day-of-month (e.g. "ayın 15'i" for
 * a payday-based budgeting cycle). Presets themselves are a UI convenience,
 * not financial data, so — like guest-store.ts's transactions — they live
 * entirely in `localStorage`, independent of account/guest mode: even a
 * signed-in user's saved presets are per-browser, not synced server-side.
 *
 * This module is deliberately NOT under `lib/domain/**` even though the
 * date math is pure: domain/ is reserved for logic shared with a future
 * mobile client (transactions, budgets, recurrence) per CLAUDE.md, and
 * these presets are a filter-panel-only convenience with no server
 * counterpart, so keeping them under `lib/client/` (alongside the
 * conceptually similar `guest-store.ts`) is the more honest location.
 */

const STORAGE_KEY = "butcem:custom-monthly-presets:v1";

export interface CustomMonthlyPreset {
  id: string;
  /** 1–31, the day-of-month this preset is anchored to. */
  day: number;
  /** Optional user-given name (e.g. "Maaş dönemi"); falls back to "Ayın
   * {day}'i" wherever displayed if omitted. */
  label?: string;
  createdAt: string;
}

export interface ResolvedCustomMonthlyRange {
  from: string;
  to: string;
  /** True when `day` doesn't exist in the resolved cycle's target month
   * (e.g. 30 in February, 31 in September) and the range's start was
   * rolled forward to the 1st of the following month instead. Callers
   * should surface an explanation built from `fallbackDetails` to the user
   * when this is true. */
  fallbackApplied: boolean;
  /** Raw values for the caller to interpolate into a translated sentence
   * (`custom-monthly-range-button.tsx`'s `transactions.customMonthly.explanation`
   * key) — kept as data rather than a pre-built Turkish string so this
   * framework-independent module never needs to know about next-intl. Only
   * set when `fallbackApplied` is true. */
  fallbackDetails?: { day: number; targetMonthLabel: string; fallbackDateLabel: string };
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

/** Local calendar date (not UTC) as "yyyy-mm-dd" — same convention used
 * throughout the transaction filters (see transaction-filters-bar.tsx). */
function toInputValue(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Resolves a day-of-month anchor to a concrete from/to range, ending today:
 *
 * 1. Find the most recent occurrence of `day` — this month's if today's
 *    date-of-month is already ≥ `day`, otherwise last month's (so the
 *    range always covers a full cycle-in-progress, never a single day).
 * 2. If that target month doesn't actually have `day` days (30 in
 *    February; 31 in April/June/September/November/February), the cycle
 *    is defined to start on the 1st of the month AFTER the target month
 *    instead (e.g. "31" in September → 1 Ekim), since that's the first
 *    real calendar day the missing anchor would have landed on.
 *
 * `intlLocale` (a BCP 47 tag — "tr-TR"/"en-US", see lib/client/intl-locale.ts)
 * only affects how `fallbackDetails`' month/date labels are formatted;
 * defaults to "tr-TR" for any pre-existing call site that hasn't been
 * updated to pass the active locale.
 */
export function resolveCustomMonthlyRange(
  day: number,
  now: Date = new Date(),
  intlLocale: string = "tr-TR"
): ResolvedCustomMonthlyRange {
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-indexed target month

  if (now.getDate() < day) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }

  const daysInTargetMonth = new Date(year, month + 1, 0).getDate();

  if (day <= daysInTargetMonth) {
    const start = new Date(year, month, day);
    return { from: toInputValue(start), to: toInputValue(now), fallbackApplied: false };
  }

  // `day` doesn't exist in the target month — roll forward to the 1st of
  // the following month instead.
  let fallbackMonth = month + 1;
  let fallbackYear = year;
  if (fallbackMonth > 11) {
    fallbackMonth = 0;
    fallbackYear += 1;
  }
  const start = new Date(fallbackYear, fallbackMonth, 1);
  const targetMonthLabel = new Intl.DateTimeFormat(intlLocale, { month: "long", year: "numeric" }).format(
    new Date(year, month, 1)
  );
  const fallbackDateLabel = new Intl.DateTimeFormat(intlLocale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(start);

  return {
    from: toInputValue(start),
    to: toInputValue(now),
    fallbackApplied: true,
    fallbackDetails: { day, targetMonthLabel, fallbackDateLabel },
  };
}

export function listCustomMonthlyPresets(): CustomMonthlyPreset[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function persist(presets: CustomMonthlyPreset[]): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function saveCustomMonthlyPreset(input: { day: number; label?: string }): CustomMonthlyPreset {
  const preset: CustomMonthlyPreset = {
    id: `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    day: input.day,
    label: input.label?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  const next = [...listCustomMonthlyPresets(), preset];
  persist(next);
  return preset;
}

export function deleteCustomMonthlyPreset(id: string): void {
  persist(listCustomMonthlyPresets().filter((preset) => preset.id !== id));
}
