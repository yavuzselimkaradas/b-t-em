"use client";

import { useEffect, useState, type ReactElement } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Decimal from "decimal.js";
import {
  AlertCircle,
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  FilterX,
  Loader2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";

import { cn } from "@/lib/utils";
import { formatAmount, type CurrencyCode } from "@/lib/domain/currency";
import { getTransactionSource, type TransactionSourceMode } from "@/lib/client/transactions-source";
import { toIntlLocale } from "@/lib/client/intl-locale";
import type { Locale } from "@/i18n/locale";
import { clampToToday, toInputValue } from "@/components/transactions/transaction-filters-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface TrendViewProps {
  mode: TransactionSourceMode;
}

type Granularity = "day" | "month" | "year";

interface TrendBucket {
  /** "yyyy-mm-dd" for a day bucket, "yyyy-mm" for a month bucket, "yyyy"
   * for a year bucket — whichever `Granularity` produced it. */
  key: string;
  label: string;
  total: Decimal;
}

// Factories (not module-level constants) — every formatter here needs the
// active UI locale (a BCP 47 tag from lib/client/intl-locale.ts's
// `toIntlLocale`), which is only known once a component has called
// `useLocale()`, so each is built fresh from that value rather than fixed
// to "tr-TR" the way this file originally was.
function makeDayLabelFormatter(intlLocale: string) {
  return new Intl.DateTimeFormat(intlLocale, {
    day: "2-digit",
    month: "short",
    timeZone: "UTC", // the label is built from the key string, not a real instant — see toDateKeyUTC's note
  });
}
function makeFullDateFormatter(intlLocale: string) {
  return new Intl.DateTimeFormat(intlLocale, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
function makeMonthLabelFormatter(intlLocale: string) {
  return new Intl.DateTimeFormat(intlLocale, { month: "short", year: "2-digit", timeZone: "UTC" });
}
function makeFullMonthFormatter(intlLocale: string) {
  return new Intl.DateTimeFormat(intlLocale, { month: "long", year: "numeric", timeZone: "UTC" });
}
function makeRangeLabelFormatter(intlLocale: string) {
  return new Intl.DateTimeFormat(intlLocale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** UTC-based "yyyy-mm-dd" for a STORED transaction's `date` — matches how
 * transaction dates are parsed/round-tripped elsewhere (UTC midnight, see
 * transaction-form.tsx's `toDateInputValue`), a different convention from
 * `toInputValue`'s local-timezone one (that's for date INPUTS the user is
 * actively picking "today" on). Bucketing must use the same convention the
 * data was stored with, or a transaction dated e.g. "12.08" could land in
 * the wrong bucket depending on the browser's timezone offset. */
function toDateKeyUTC(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toMonthKeyUTC(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function toYearKeyUTC(date: Date): string {
  return String(date.getUTCFullYear());
}

/** Capitalizes a translated granularity word ("günlük"/"aylık"/"yıllık" or
 * "daily"/"monthly"/"yearly") for the page heading — works the same way
 * regardless of locale since both languages capitalize by uppercasing the
 * first letter. Replaces the old `granularityLabel` helper, which built the
 * (Turkish-only) word itself; the word now always comes from next-intl. */
function capitalize(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** One bucket per calendar day from `fromKey` to `toKey` inclusive
 * (local-timezone dateKeys, same convention as every other date filter in
 * this app). If `fromKey` is after `toKey` (a malformed/tampered URL), the
 * range silently collapses to just `toKey` rather than looping forever or
 * throwing — this page has no server-side validation of its own query
 * params to fall back on. */
function buildDayBuckets(fromKey: string, toKey: string, intlLocale: string): TrendBucket[] {
  const dayLabelFormatter = makeDayLabelFormatter(intlLocale);
  const from = new Date(`${fromKey}T00:00:00`);
  const to = new Date(`${toKey}T00:00:00`);
  const buckets: TrendBucket[] = [];
  const cursor = from.getTime() <= to.getTime() ? new Date(from) : new Date(to);
  const end = from.getTime() <= to.getTime() ? to : from;
  while (cursor.getTime() <= end.getTime()) {
    const dateKey = toInputValue(cursor);
    buckets.push({
      key: dateKey,
      label: dayLabelFormatter.format(new Date(`${dateKey}T00:00:00Z`)),
      total: new Decimal(0),
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return buckets;
}

/** One bucket per calendar MONTH touched by `fromKey`..`toKey` (inclusive
 * of both endpoints' months, even if the range starts/ends mid-month) —
 * e.g. "Bu yıl" (Oca–Ağu) produces 8 buckets, not 8×~30 day buckets. Same
 * malformed-range fallback as `buildDayBuckets`. */
function buildMonthBuckets(fromKey: string, toKey: string, intlLocale: string): TrendBucket[] {
  const monthLabelFormatter = makeMonthLabelFormatter(intlLocale);
  const from = new Date(`${fromKey}T00:00:00`);
  const to = new Date(`${toKey}T00:00:00`);
  const start = from.getTime() <= to.getTime() ? from : to;
  const end = from.getTime() <= to.getTime() ? to : from;

  const buckets: TrendBucket[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cursor.getTime() <= endMonth.getTime()) {
    const monthKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    buckets.push({
      key: monthKey,
      label: monthLabelFormatter.format(new Date(`${monthKey}-01T00:00:00Z`)),
      total: new Decimal(0),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return buckets;
}

/** One bucket per calendar YEAR from `fromKey` to `toKey` inclusive — for
 * the "Yıllık" preset, which spans however many years the user has data
 * for, not a fixed window. Same malformed-range fallback as
 * `buildDayBuckets`. */
function buildYearBuckets(fromKey: string, toKey: string): TrendBucket[] {
  const from = new Date(`${fromKey}T00:00:00`);
  const to = new Date(`${toKey}T00:00:00`);
  const startYear = Math.min(from.getFullYear(), to.getFullYear());
  const endYear = Math.max(from.getFullYear(), to.getFullYear());

  const buckets: TrendBucket[] = [];
  for (let year = startYear; year <= endYear; year++) {
    buckets.push({ key: String(year), label: String(year), total: new Decimal(0) });
  }
  return buckets;
}

interface RangePreset {
  key: string;
  label: string;
  range: () => { from: string; to: string };
}

function last7Days(): { from: string; to: string } {
  const now = new Date();
  return {
    from: toInputValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)),
    to: toInputValue(now),
  };
}

function thisYearRange(): { from: string; to: string } {
  const now = new Date();
  const today = toInputValue(now);
  return { from: `${now.getFullYear()}-01-01`, to: clampToToday(`${now.getFullYear()}-12-31`, today) };
}

/** Whole calendar-month distance between two "yyyy-mm-dd" keys — e.g.
 * 15 Oca → 20 Mar is 2 (Oca→Mar), even though not a full 60 days have
 * elapsed. Used only to gate the manual Başlangıç/Bitiş granularity
 * dropdown below, so this coarse "how many month boundaries were crossed"
 * measure is the right granularity for that decision, not day-precision. */
function monthSpan(fromKey: string, toKey: string): number {
  const from = new Date(`${fromKey}T00:00:00`);
  const to = new Date(`${toKey}T00:00:00`);
  return Math.abs((to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()));
}

/**
 * The "Günlük"/"Aylık" chart-view chooser — identical popup content
 * wherever it's used (currently: the "Bu yıl" preset's own trigger, and
 * the manual Başlangıç/Bitiş range's conditional one below), only the
 * trigger element differs.
 */
function GranularityDropdown({
  trigger,
  value,
  onSelect,
}: {
  trigger: ReactElement;
  value: Granularity;
  onSelect: (value: Granularity) => void;
}) {
  const t = useTranslations("transactions.trend");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="start">
        {/* Base UI's `Menu.GroupLabel` (`DropdownMenuLabel`) needs a
            `Menu.Group`/`Menu.RadioGroup` ancestor providing its group
            context — it can't sit as a plain sibling of
            `DropdownMenuRadioGroup`, only inside one. */}
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onSelect(next as Granularity)}
        >
          <DropdownMenuLabel>{t("viewChooserLabel")}</DropdownMenuLabel>
          <DropdownMenuRadioItem value="day">{t("viewDay")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="month">{t("viewMonth")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Built inside the component (not a module-level constant) since the
 * labels need `useTranslations` — see the same pattern in
 * transaction-filters-bar.tsx's `TYPE_OPTIONS`/`PERIOD_OPTIONS`. */
function buildRangePresets(t: ReturnType<typeof useTranslations>): RangePreset[] {
  return [
    { key: "7d", label: t("presetLast7"), range: last7Days },
    {
      key: "30d",
      label: t("presetLast30"),
      range: () => {
        const now = new Date();
        return {
          from: toInputValue(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)),
          to: toInputValue(now),
        };
      },
    },
    {
      key: "month",
      label: t("presetThisMonth"),
      range: () => {
        const now = new Date();
        const today = toInputValue(now);
        const first = toInputValue(new Date(now.getFullYear(), now.getMonth(), 1));
        const last = toInputValue(new Date(now.getFullYear(), now.getMonth() + 1, 0));
        return { from: first, to: clampToToday(last, today) };
      },
    },
    { key: "year", label: t("presetThisYear"), range: thisYearRange },
  ];
}

type TrendState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; buckets: TrendBucket[] };

/** One fetched transaction, narrowed to the fields bucketing/currency-tab
 * logic needs. Fetched ONCE per (type, from, to) — independent of
 * `granularity` AND the selected currency tab — so switching between
 * "Günlük"/"Aylık" or between currency tabs re-buckets client-side
 * (`useMemo` below) instead of re-fetching from the server every time. */
interface RawRecord {
  date: Date;
  amount: Decimal.Value;
  currency: CurrencyCode;
}

type RawState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; records: RawRecord[] };

/** "TRY" always first (present even with zero TRY transactions in range —
 * same zero-fill convention `summarize` uses elsewhere), any other currency
 * actually present in `records` appended after, alphabetically — a stable,
 * deterministic tab order. */
function availableCurrencies(records: RawRecord[]): CurrencyCode[] {
  const others = Array.from(new Set(records.map((r) => r.currency)))
    .filter((c): c is Exclude<CurrencyCode, "TRY"> => c !== "TRY")
    .sort();
  return ["TRY", ...others];
}

/**
 * Buckets `rawState.records` by day/month/year AND by `selectedCurrency` —
 * a record whose `currency !== selectedCurrency` is simply excluded (never
 * converted), so switching currency tabs shows a completely separate
 * dataset, per the approved plan's "sekmeler tamamen ayrı veri kümeleri"
 * rule. A plain pure function (not a `useMemo`) — recomputed every render,
 * same as this file's other small pure derivations (`buildDayBuckets` etc.)
 * below it; the loop is a single pass over an already-fetched, in-memory
 * array, cheap enough not to need memoizing.
 */
function buildTrendState(
  rawState: RawState,
  granularity: Granularity,
  from: string,
  to: string,
  selectedCurrency: CurrencyCode,
  intlLocale: string
): TrendState {
  if (rawState.status !== "success") return rawState;

  const buckets =
    granularity === "year"
      ? buildYearBuckets(from, to)
      : granularity === "month"
        ? buildMonthBuckets(from, to, intlLocale)
        : buildDayBuckets(from, to, intlLocale);
  const toKey = granularity === "year" ? toYearKeyUTC : granularity === "month" ? toMonthKeyUTC : toDateKeyUTC;

  const totals = new Map(buckets.map((bucket) => [bucket.key, new Decimal(0)]));
  for (const record of rawState.records) {
    if (record.currency !== selectedCurrency) continue;
    const key = toKey(new Date(record.date));
    const running = totals.get(key);
    // A transaction just outside the window (timezone edge at the
    // boundary) is skipped rather than thrown at a bucket that doesn't
    // exist.
    if (running !== undefined) {
      totals.set(key, running.plus(new Decimal(record.amount)));
    }
  }
  const filled = buckets.map((bucket) => ({
    ...bucket,
    total: totals.get(bucket.key) ?? new Decimal(0),
  }));
  return { status: "success", buckets: filled };
}

/**
 * Daily (or, for "Bu yıl", optionally monthly) line chart for ONE flow
 * (income or expense), reached by clicking "Gelir dağılımı"/"Gider
 * dağılımı" on the pie chart — a different question than that card answers
 * ("which categories make up the total") vs. this page's ("how is the
 * amount moving over time"). Defaults to the last 7 days; the filter panel
 * below the header lets the user pick any other range (quick presets or a
 * manual Başlangıç/Bitiş), same URL-synced pattern `TransactionsView` uses
 * for its own filters — shareable, survives a refresh/back-navigation.
 * Fetches via `source.exportAll` (all matching rows, not a page — see the
 * same reasoning in transactions-view.tsx's breakdown fetch) scoped to
 * `type` + the selected range, then buckets client-side by day or month.
 */
export function TrendView({ mode }: TrendViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("transactions.trend");
  const tList = useTranslations("transactions.list");
  const tFilters = useTranslations("transactions.filters");
  const tForm = useTranslations("transactions.form");
  const locale = useLocale() as Locale;
  const intlLocale = toIntlLocale(locale);
  const RANGE_PRESETS = buildRangePresets(t);

  const rawType = searchParams.get("type");
  // Defaults to EXPENSE rather than erroring on a missing/garbled `type` —
  // a plausible way to land here (typed URL, stale bookmark, back button).
  const type: "INCOME" | "EXPENSE" = rawType === "INCOME" ? "INCOME" : "EXPENSE";
  const isIncome = type === "INCOME";
  const source = getTransactionSource(mode);

  const defaultRange = last7Days();
  const today = toInputValue(new Date());
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  // A manually-typed `from`/`to` is capped at today the same way the main
  // filter bar's date inputs are (see transaction-filters-bar.tsx) — no
  // future-dated data can exist, so a future bound is never meaningful.
  const from = rawFrom ? clampToToday(rawFrom, today) : defaultRange.from;
  const to = rawTo ? clampToToday(rawTo, today) : defaultRange.to;
  const isDefaultRange = from === defaultRange.from && to === defaultRange.to;
  const activePreset = RANGE_PRESETS.find((preset) => {
    const r = preset.range();
    return r.from === from && r.to === to;
  })?.key;
  const granularityParam = searchParams.get("granularity");
  // "Yıllık" is tracked purely through `?granularity=year`, not a matched
  // preset range — unlike every other preset, its `from` depends on the
  // user's actual data (the year their earliest transaction falls in), so
  // it can't be a fixed formula checked via `activePreset` above. See
  // `applyYearlyPreset` below for where this gets set.
  const isYearlyMode = granularityParam === "year";
  // Any range that isn't a matched preset (typed manually here, OR carried
  // over from the İşlemler page's own date filter — see category-pie-chart.tsx's
  // `from`/`to` link params) but spans 2+ calendar months gets the same
  // Günlük/Aylık chooser "Bu yıl" has, shown at the chart's bottom-right
  // (see the `<Line>` section below) — daily points over a multi-month
  // range get just as dense as a full year does either way. Not offered
  // while already in "Yıllık" mode — that mode's whole point is a fixed
  // per-year axis, no day/month choice.
  const isLongRange = !activePreset && !isYearlyMode && monthSpan(from, to) >= 2;
  // Monthly grouping only ever applies to "Bu yıl" or a qualifying long
  // range (see the dropdowns below) — outside those, a stray
  // `?granularity=month` from an old URL/link is ignored rather than
  // silently applied somewhere it was never offered. Always starts on
  // "Günlük" the moment the range changes — the chooser only ever narrows
  // it to "Aylık" on an explicit click.
  const granularity: Granularity = isYearlyMode
    ? "year"
    : (activePreset === "year" || isLongRange) && granularityParam === "month"
      ? "month"
      : "day";

  // "TRY" default — matches every other multi-currency surface in this app
  // (`summarize`'s "TRY always present, always first" rule). A stray/stale
  // `?currency=` value that isn't a real `CurrencyCode` falls back to "TRY"
  // the same way `type` falls back to "EXPENSE" above.
  const currencyParam = searchParams.get("currency");
  const selectedCurrency: CurrencyCode =
    currencyParam === "USD" || currencyParam === "EUR" ? currencyParam : "TRY";

  const [rawState, setRawState] = useState<RawState>({ status: "loading" });
  const [yearlyLoading, setYearlyLoading] = useState(false);

  const updateRange = (patch: { from?: string; to?: string; granularity?: Granularity }) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("type", type);
    params.set("from", patch.from ?? from);
    params.set("to", patch.to ?? to);
    // Any range change resets to daily unless the caller explicitly asked
    // for monthly/yearly (the "Bu yıl" dropdown, the bottom-right chooser,
    // or "Yıllık") — a 7-day or custom range grouped monthly/yearly would
    // just be a single flat point.
    if (patch.granularity === "month" || patch.granularity === "year") {
      params.set("granularity", patch.granularity);
    } else {
      params.delete("granularity");
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  /** Switches the currency tab — a pure client-side re-bucket (see the
   * `useMemo` below), no new fetch. Preserves every other param (range,
   * granularity) the same way `updateRange` does. */
  const updateCurrency = (next: CurrencyCode) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("type", type);
    if (next === "TRY") {
      params.delete("currency");
    } else {
      params.set("currency", next);
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  const resetRange = () => {
    const params = new URLSearchParams();
    params.set("type", type);
    router.push(`${pathname}?${params.toString()}`);
  };

  // "Yıllık": from the year the user's earliest matching transaction falls
  // in, through the current year — unlike every other preset this needs a
  // lookup first (there's no fixed formula for "when did this user's data
  // begin"), so it's a click handler that fetches, not a synchronous
  // `RangePreset.range()`. No transactions at all yet → falls back to just
  // the current year, so the chart still renders something sensible
  // instead of an empty/invalid range.
  const applyYearlyPreset = async () => {
    setYearlyLoading(true);
    const currentYear = new Date().getFullYear();
    try {
      const result = await source.earliestDate({ type });
      const earliestYear =
        result.success && result.data.date ? Number(result.data.date.slice(0, 4)) : currentYear;
      updateRange({
        from: `${earliestYear}-01-01`,
        to: clampToToday(`${currentYear}-12-31`, today),
        granularity: "year",
      });
    } catch {
      updateRange({
        from: `${currentYear}-01-01`,
        to: clampToToday(`${currentYear}-12-31`, today),
        granularity: "year",
      });
    } finally {
      setYearlyLoading(false);
    }
  };

  // Fetches ALL matching rows for `type`/`from`/`to` — every currency mixed
  // together — exactly once per range (NOT per granularity, NOT per
  // currency tab); every state update happens inside a `.then()`/`.catch()`
  // callback, never synchronously in the effect body — same discipline as
  // this file's siblings (NetTotalCard, YearPickerPanel,
  // transactions-view.tsx's breakdown fetch).
  useEffect(() => {
    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        setRawState({ status: "loading" });
        return source.exportAll({ type, from, to });
      })
      .then((result) => {
        if (cancelled || !result) return;
        if (!result.success) {
          setRawState({ status: "error", message: result.error });
          return;
        }
        setRawState({
          status: "success",
          records: result.data.map((transaction) => ({
            date: transaction.date,
            amount: transaction.amount,
            currency: transaction.currency,
          })),
        });
      })
      .catch(() => {
        if (!cancelled) setRawState({ status: "error", message: t("loadError") });
      });

    return () => {
      cancelled = true;
    };
  }, [type, from, to, source, t]);

  const currencyTabs: CurrencyCode[] =
    rawState.status === "success" ? availableCurrencies(rawState.records) : ["TRY"];

  // Pure derived state, recomputed each render (no `useMemo` needed — see
  // `buildTrendState`'s doc comment) — no fetch here, just a re-bucket of
  // the already-fetched `rawState.records`.
  const state: TrendState = buildTrendState(
    rawState,
    granularity,
    from,
    to,
    selectedCurrency,
    intlLocale
  );

  const total =
    state.status === "success"
      ? state.buckets.reduce((sum, bucket) => sum.plus(bucket.total), new Decimal(0))
      : new Decimal(0);
  const currency = selectedCurrency;
  const Icon = isIncome ? ArrowUpRight : ArrowDownRight;
  const rangeLabelFormatter = makeRangeLabelFormatter(intlLocale);
  const rangeLabel = `${rangeLabelFormatter.format(new Date(`${from}T00:00:00Z`))} – ${rangeLabelFormatter.format(new Date(`${to}T00:00:00Z`))}`;
  const granularityWord = t(
    granularity === "year" ? "granularityYear" : granularity === "month" ? "granularityMonth" : "granularityDay"
  );
  // Capitalized "Gelir"/"Gider" ("Income"/"Expense") for the heading — same
  // key `TransactionsView`'s type badge uses (`transactions.list.typeIncome`/
  // `typeExpense`), reused rather than duplicated under `trend.*`.
  const headingFlow = tList(isIncome ? "typeIncome" : "typeExpense");
  // Genitive form ("gelirlerinin"/"giderlerinin" — "income's"/"expenses'")
  // for the subtitle sentence.
  const subtitleFlow = t(isIncome ? "flowIncomeLower" : "flowExpenseLower");
  // Bare lowercase noun ("gelir"/"gider" — "income"/"expense") for the
  // card title and the empty-state sentence.
  const flowNoun = t(isIncome ? "flowIncomeNoun" : "flowExpenseNoun");

  // Beyond ~14 points, showing every label on the X axis overlaps — thin
  // them out to roughly 10 evenly-spaced ticks instead of relying on
  // Recharts' default (which doesn't rotate/skip on its own here). Month
  // buckets rarely exceed ~12 (a year), so this is mostly a day-view concern.
  const bucketCount = state.status === "success" ? state.buckets.length : 0;
  const tickInterval = bucketCount <= 14 ? 0 : Math.ceil(bucketCount / 10) - 1;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/transactions"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {t("back")}
        </Link>
        <h1 className="font-display mt-2 flex items-center gap-2 text-3xl font-semibold tracking-tight text-foreground">
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              isIncome ? "bg-income-soft text-income" : "bg-destructive/10 text-destructive"
            )}
          >
            <Icon className="size-4" strokeWidth={2.5} />
          </span>
          {t("heading", { flow: headingFlow, granularity: capitalize(granularityWord) })}
        </h1>
        <p className="mt-1.5 text-muted-foreground">
          {t("subtitle", { flow: subtitleFlow, granularity: granularityWord })}
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex flex-col gap-1.5">
          <Label id="trend-preset-label" className="text-xs text-muted-foreground">
            {t("rangeLabel")}
          </Label>
          <div
            role="radiogroup"
            aria-labelledby="trend-preset-label"
            className="inline-flex w-fit flex-wrap rounded-lg bg-muted p-0.5"
          >
            {RANGE_PRESETS.map((preset) =>
              preset.key === "year" ? (
                // "Bu yıl" alone opens a dropdown instead of applying
                // immediately — a full year at daily granularity is ~365
                // points, dense enough that offering a monthly view is
                // worth the extra click. Every other preset stays a plain
                // single-click button (their ranges are short enough that
                // daily is always the right call).
                <GranularityDropdown
                  key={preset.key}
                  trigger={
                    <button
                      type="button"
                      role="radio"
                      aria-checked={activePreset === "year"}
                      className={cn(
                        "flex items-center gap-1 rounded-[7px] px-2.5 py-1 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                        activePreset === "year"
                          ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {preset.label}
                      <ChevronDown className="size-3" />
                    </button>
                  }
                  value={activePreset === "year" ? granularity : "day"}
                  onSelect={(value) => updateRange({ ...preset.range(), granularity: value })}
                />
              ) : (
                <button
                  key={preset.key}
                  type="button"
                  role="radio"
                  aria-checked={activePreset === preset.key}
                  onClick={() => updateRange(preset.range())}
                  className={cn(
                    "rounded-[7px] px-2.5 py-1 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    activePreset === preset.key
                      ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {preset.label}
                </button>
              )
            )}
            {/* "Yıllık": from the year the user's data begins through this
                year, one point PER YEAR — a fixed axis unit, unlike "Bu
                yıl"/the bottom-right chooser, so this is a plain button (no
                Günlük/Aylık dropdown) that fetches the start year on click. */}
            <button
              type="button"
              role="radio"
              aria-checked={isYearlyMode}
              disabled={yearlyLoading}
              onClick={applyYearlyPreset}
              className={cn(
                "flex items-center gap-1 rounded-[7px] px-2.5 py-1 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60",
                isYearlyMode
                  ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {yearlyLoading ? <Loader2 className="size-3 animate-spin" /> : null}
              {t("presetYearly")}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="trend-from" className="text-xs text-muted-foreground">
            {tFilters("from")}
          </Label>
          <Input
            id="trend-from"
            type="date"
            className="w-36"
            value={from}
            max={to && to < today ? to : today}
            onChange={(event) => updateRange({ from: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="trend-to" className="text-xs text-muted-foreground">
            {tFilters("to")}
          </Label>
          <Input
            id="trend-to"
            type="date"
            className="w-36"
            value={to}
            min={from || undefined}
            max={today}
            onChange={(event) => updateRange({ to: event.target.value })}
          />
        </div>

        {/* Currency tabs — only shown once the range actually holds more
         * than one currency (a pure-TRY range, still the overwhelming
         * majority of data today, keeps looking exactly like it always
         * has — see this feature's regression requirement). TRY is always
         * the first tab and the default selection; switching tabs never
         * converts/mixes currencies, each is its own independent dataset
         * (design decision, approved plan). */}
        {currencyTabs.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label id="trend-currency-label" className="text-xs text-muted-foreground">
              {tForm("currencyLabel")}
            </Label>
            <div
              role="radiogroup"
              aria-labelledby="trend-currency-label"
              className="inline-flex w-fit flex-wrap rounded-lg bg-muted p-0.5"
            >
              {currencyTabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="radio"
                  aria-checked={selectedCurrency === tab}
                  onClick={() => updateCurrency(tab)}
                  className={cn(
                    "rounded-[7px] px-2.5 py-1 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    selectedCurrency === tab
                      ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {!isDefaultRange ? (
          <Button type="button" variant="ghost" size="sm" onClick={resetRange} className="sm:ml-auto">
            <FilterX className="size-3.5" />
            {t("clearFilter")}
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 [.border-b]:pb-0">
          <div>
            <CardTitle>
              {capitalize(granularityWord)} {flowNoun}
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">{rangeLabel}</p>
          </div>
          {state.status === "success" ? (
            <span
              className={cn(
                "num-tabular text-lg font-semibold",
                isIncome ? "text-income" : "text-destructive"
              )}
            >
              {t("total", { value: formatAmount(total, currency) })}
            </span>
          ) : null}
        </CardHeader>
        <CardContent>
          {state.status === "loading" ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : state.status === "error" ? (
            <div
              role="alert"
              className="flex h-64 flex-col items-center justify-center gap-2 text-center text-sm text-destructive"
            >
              <AlertCircle className="size-5 shrink-0" />
              {state.message}
            </div>
          ) : total.isZero() ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm text-muted-foreground">{t("noData", { flow: flowNoun })}</p>
            </div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={state.buckets.map((bucket) => ({
                    label: bucket.label,
                    key: bucket.key,
                    amount: bucket.total.toNumber(),
                  }))}
                  margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                    interval={tickInterval}
                  />
                  <YAxis
                    tick={{ fontSize: 12, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    width={48}
                    tickFormatter={(value: number) =>
                      new Intl.NumberFormat(intlLocale, { notation: "compact" }).format(value)
                    }
                  />
                  <Tooltip
                    content={(props) => (
                      <BucketTooltip {...props} currency={currency} granularity={granularity} />
                    )}
                  />
                  <Line
                    type="monotone"
                    dataKey="amount"
                    stroke={isIncome ? "var(--income)" : "var(--destructive)"}
                    strokeWidth={2.5}
                    dot={
                      bucketCount <= 31
                        ? { r: 3.5, strokeWidth: 0, fill: isIncome ? "var(--income)" : "var(--destructive)" }
                        : false
                    }
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {isLongRange && state.status === "success" && !total.isZero() ? (
            // Bottom-right, under the chart — same Günlük/Aylık chooser
            // "Bu yıl" offers (see `GranularityDropdown`), just placed next
            // to the chart it affects instead of up in the filter row.
            // Doesn't change `from`/`to`, only how the already-selected
            // range is bucketed.
            <div className="mt-2 flex justify-end">
              <GranularityDropdown
                trigger={
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {t("viewLabel", { view: granularity === "month" ? t("viewMonth") : t("viewDay") })}
                    <ChevronDown className="size-3.5" />
                  </button>
                }
                value={granularity}
                onSelect={(value) => updateRange({ granularity: value })}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function BucketTooltip({
  active,
  payload,
  currency,
  granularity,
}: TooltipContentProps & { currency: CurrencyCode; granularity: Granularity }) {
  const locale = useLocale() as Locale;
  const intlLocale = toIntlLocale(locale);
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as { key: string; amount: number };
  const dateLabel =
    granularity === "year"
      ? point.key // already just the bare "yyyy" — nothing further to format
      : granularity === "month"
        ? makeFullMonthFormatter(intlLocale).format(new Date(`${point.key}-01T00:00:00Z`))
        : makeFullDateFormatter(intlLocale).format(new Date(`${point.key}T00:00:00Z`));
  return (
    <div className="rounded-lg bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <p className="font-medium">{dateLabel}</p>
      <p className="num-tabular mt-0.5 text-muted-foreground">{formatAmount(point.amount, currency)}</p>
    </div>
  );
}
