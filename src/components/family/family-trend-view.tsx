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
  MousePointerClick,
} from "lucide-react";
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
import { exportFamilyTransactions, earliestFamilyTransactionDate } from "@/lib/server/actions/family-transactions";
import { clampToToday, toInputValue } from "@/components/transactions/transaction-filters-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Family-scoped sibling of components/transactions/trend-view.tsx —
// deliberately a SEPARATE file rather than a `mode: "family"` branch added
// to that one: `TrendView` is keyed on `TransactionSource`
// (lib/client/transactions-source.ts), a one-argument (`filters`) account/
// guest abstraction; the family-scope reads
// (`exportFamilyTransactions`/`earliestFamilyTransactionDate`) take a
// `familyId` as a SEPARATE first argument, which doesn't fit that
// abstraction's shape. Keeping this a standalone file also means this new
// per-member drill-down feature (2026-08-22) can't regress the individual
// page. The date-key/bucket-building helpers below are intentionally
// duplicated from trend-view.tsx (not extracted to a shared module this
// round) — same small pure functions, kept in sync by eye; a `simplify`
// pass can de-duplicate them later if that's ever worth doing.

type Granularity = "day" | "month" | "year";

/** One member's contribution to a single bucket — `ownerName` mirrors
 * `FamilyTransactionRow.ownerName` (lib/server/actions/family-transactions.ts,
 * "Eski üye" for a former member, same collision caveat as everywhere else
 * that label is used: two different former members both show as "Eski
 * üye", amounts stay correctly separated by `userId` regardless). */
interface MemberContribution {
  userId: string;
  ownerName: string;
  amount: Decimal;
}

interface TrendBucket {
  /** "yyyy-mm-dd" for a day bucket, "yyyy-mm" for a month bucket, "yyyy"
   * for a year bucket — whichever `Granularity` produced it. */
  key: string;
  label: string;
  total: Decimal;
  /** Highest contributor first, lowest last — same "biggest first" sort
   * convention as `familyMemberBreakdown` (family-transactions.ts). Built
   * once per fetch (not recomputed on every click), so selecting a bucket is
   * just a lookup. */
  byMember: MemberContribution[];
}

const dayLabelFormatter = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});
const fullDateFormatter = new Intl.DateTimeFormat("tr-TR", {
  weekday: "long",
  day: "2-digit",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const monthLabelFormatter = new Intl.DateTimeFormat("tr-TR", { month: "short", year: "2-digit", timeZone: "UTC" });
const fullMonthFormatter = new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric", timeZone: "UTC" });
const rangeLabelFormatter = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const percentFormatter = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

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

function granularityLabel(granularity: Granularity, capitalized: boolean): string {
  const label = granularity === "year" ? "yıllık" : granularity === "month" ? "aylık" : "günlük";
  return capitalized ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

function emptyBuckets(keys: { key: string; label: string }[]): TrendBucket[] {
  return keys.map((k) => ({ ...k, total: new Decimal(0), byMember: [] }));
}

function buildDayBuckets(fromKey: string, toKey: string): TrendBucket[] {
  const from = new Date(`${fromKey}T00:00:00`);
  const to = new Date(`${toKey}T00:00:00`);
  const keys: { key: string; label: string }[] = [];
  const cursor = from.getTime() <= to.getTime() ? new Date(from) : new Date(to);
  const end = from.getTime() <= to.getTime() ? to : from;
  while (cursor.getTime() <= end.getTime()) {
    const dateKey = toInputValue(cursor);
    keys.push({ key: dateKey, label: dayLabelFormatter.format(new Date(`${dateKey}T00:00:00Z`)) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return emptyBuckets(keys);
}

function buildMonthBuckets(fromKey: string, toKey: string): TrendBucket[] {
  const from = new Date(`${fromKey}T00:00:00`);
  const to = new Date(`${toKey}T00:00:00`);
  const start = from.getTime() <= to.getTime() ? from : to;
  const end = from.getTime() <= to.getTime() ? to : from;

  const keys: { key: string; label: string }[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
  while (cursor.getTime() <= endMonth.getTime()) {
    const monthKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
    keys.push({ key: monthKey, label: monthLabelFormatter.format(new Date(`${monthKey}-01T00:00:00Z`)) });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return emptyBuckets(keys);
}

function buildYearBuckets(fromKey: string, toKey: string): TrendBucket[] {
  const from = new Date(`${fromKey}T00:00:00`);
  const to = new Date(`${toKey}T00:00:00`);
  const startYear = Math.min(from.getFullYear(), to.getFullYear());
  const endYear = Math.max(from.getFullYear(), to.getFullYear());
  const keys: { key: string; label: string }[] = [];
  for (let year = startYear; year <= endYear; year++) {
    keys.push({ key: String(year), label: String(year) });
  }
  return emptyBuckets(keys);
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

function monthSpan(fromKey: string, toKey: string): number {
  const from = new Date(`${fromKey}T00:00:00`);
  const to = new Date(`${toKey}T00:00:00`);
  return Math.abs((to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()));
}

function GranularityDropdown({
  trigger,
  value,
  onSelect,
}: {
  trigger: ReactElement;
  value: Granularity;
  onSelect: (value: Granularity) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onSelect(next as Granularity)}>
          <DropdownMenuLabel>Grafik görünümü</DropdownMenuLabel>
          <DropdownMenuRadioItem value="day">Günlük</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="month">Aylık</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const RANGE_PRESETS: RangePreset[] = [
  { key: "7d", label: "Son 7 gün", range: last7Days },
  {
    key: "30d",
    label: "Son 30 gün",
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
    label: "Bu ay",
    range: () => {
      const now = new Date();
      const today = toInputValue(now);
      const first = toInputValue(new Date(now.getFullYear(), now.getMonth(), 1));
      const last = toInputValue(new Date(now.getFullYear(), now.getMonth() + 1, 0));
      return { from: first, to: clampToToday(last, today) };
    },
  },
  { key: "year", label: "Bu yıl", range: thisYearRange },
];

type TrendState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; buckets: TrendBucket[] };

/** One fetched transaction, narrowed to the fields bucketing/currency-tab/
 * per-member-drilldown logic needs. Fetched ONCE per (type, from, to) —
 * independent of `granularity` AND the selected currency tab — so switching
 * between "Günlük"/"Aylık" or between currency tabs re-buckets client-side
 * (`buildTrendState` below) instead of re-fetching from the server every
 * time. */
interface RawRecord {
  date: Date;
  amount: Decimal.Value;
  currency: CurrencyCode;
  userId: string;
  ownerName: string;
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
 * Buckets `rawState.records` by day/month/year AND by `selectedCurrency`
 * (a record whose `currency !== selectedCurrency` is simply excluded, never
 * converted — switching currency tabs shows a completely separate dataset,
 * per the approved plan's "sekmeler tamamen ayrı veri kümeleri" rule) AND,
 * within each bucket, by `userId` (`byMember`) for the per-member
 * drill-down panel. A plain pure function (not a `useMemo`) — recomputed
 * every render, same as `trend-view.tsx`'s identical helper; the loop is a
 * single pass over an already-fetched, in-memory array, cheap enough not to
 * need memoizing.
 */
function buildTrendState(
  rawState: RawState,
  granularity: Granularity,
  from: string,
  to: string,
  selectedCurrency: CurrencyCode
): TrendState {
  if (rawState.status !== "success") return rawState;

  const buckets =
    granularity === "year"
      ? buildYearBuckets(from, to)
      : granularity === "month"
        ? buildMonthBuckets(from, to)
        : buildDayBuckets(from, to);
  const toKey = granularity === "year" ? toYearKeyUTC : granularity === "month" ? toMonthKeyUTC : toDateKeyUTC;
  const bucketByKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  const memberTotalsByBucket = new Map<string, Map<string, { ownerName: string; amount: Decimal }>>();

  for (const record of rawState.records) {
    if (record.currency !== selectedCurrency) continue;
    const key = toKey(new Date(record.date));
    const bucket = bucketByKey.get(key);
    if (!bucket) continue; // just outside the window (timezone edge) — skip
    const amount = new Decimal(record.amount);
    bucket.total = bucket.total.plus(amount);

    let memberTotals = memberTotalsByBucket.get(key);
    if (!memberTotals) {
      memberTotals = new Map();
      memberTotalsByBucket.set(key, memberTotals);
    }
    const existing = memberTotals.get(record.userId);
    if (existing) {
      existing.amount = existing.amount.plus(amount);
    } else {
      memberTotals.set(record.userId, { ownerName: record.ownerName, amount });
    }
  }

  const filled = buckets.map((bucket) => {
    const memberTotals = memberTotalsByBucket.get(bucket.key);
    const byMember: MemberContribution[] = memberTotals
      ? Array.from(memberTotals.entries())
          .map(([userId, { ownerName, amount }]) => ({ userId, ownerName, amount }))
          .sort((a, b) => b.amount.comparedTo(a.amount))
      : [];
    return { ...bucket, byMember };
  });

  return { status: "success", buckets: filled };
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const letters = parts.map((part) => part[0]?.toUpperCase()).join("");
  return letters || "?";
}

interface FamilyTrendViewProps {
  familyId: string;
}

/**
 * Family-scoped counterpart of `TrendView` — same daily/monthly line chart
 * for one flow (income or expense), reached the same way (clicking "Gelir
 * dağılımı"/"Gider dağılımı" on the family dashboard's pie chart, see
 * `CategoryPieChart`'s `trendBasePath` prop), PLUS a per-member drill-down:
 * clicking a point on the chart opens a panel below it breaking that
 * point's total down by which family member contributed how much — "3 gün
 * önceki 1000₺'lik gider: Kullanıcı1 700₺, Kullanıcı2 300₺" (2026-08-22
 * product request). Fetches via `exportFamilyTransactions` (every matching
 * row, not just a page — same reasoning as the individual page's
 * `source.exportAll`), then buckets client-side by day/month/year AND by
 * `userId` within each bucket in the same pass.
 */
export function FamilyTrendView({ familyId }: FamilyTrendViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const rawType = searchParams.get("type");
  const type: "INCOME" | "EXPENSE" = rawType === "INCOME" ? "INCOME" : "EXPENSE";
  const isIncome = type === "INCOME";

  const defaultRange = last7Days();
  const today = toInputValue(new Date());
  const rawFrom = searchParams.get("from");
  const rawTo = searchParams.get("to");
  const from = rawFrom ? clampToToday(rawFrom, today) : defaultRange.from;
  const to = rawTo ? clampToToday(rawTo, today) : defaultRange.to;
  const isDefaultRange = from === defaultRange.from && to === defaultRange.to;
  const activePreset = RANGE_PRESETS.find((preset) => {
    const r = preset.range();
    return r.from === from && r.to === to;
  })?.key;
  const granularityParam = searchParams.get("granularity");
  const isYearlyMode = granularityParam === "year";
  const isLongRange = !activePreset && !isYearlyMode && monthSpan(from, to) >= 2;
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const updateRange = (patch: { from?: string; to?: string; granularity?: Granularity }) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("type", type);
    params.set("from", patch.from ?? from);
    params.set("to", patch.to ?? to);
    if (patch.granularity === "month" || patch.granularity === "year") {
      params.set("granularity", patch.granularity);
    } else {
      params.delete("granularity");
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  /** Switches the currency tab — a pure client-side re-bucket (see
   * `buildTrendState`), no new fetch. Preserves every other param (range,
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

  const applyYearlyPreset = async () => {
    setYearlyLoading(true);
    const currentYear = new Date().getFullYear();
    try {
      const result = await earliestFamilyTransactionDate(familyId, { type });
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

  // Fetches ALL matching rows for `type`/`from`/`to` — every currency and
  // every member mixed together — exactly once per range (NOT per
  // granularity, NOT per currency tab); every state update happens inside a
  // `.then()`/`.catch()` callback, never synchronously in the effect body —
  // same discipline as this file's siblings.
  useEffect(() => {
    let cancelled = false;

    Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        setRawState({ status: "loading" });
        setSelectedKey(null);
        return exportFamilyTransactions(familyId, { type, from, to });
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
            userId: transaction.userId,
            ownerName: transaction.ownerName,
          })),
        });
      })
      .catch(() => {
        if (!cancelled) setRawState({ status: "error", message: "Veriler yüklenemedi." });
      });

    return () => {
      cancelled = true;
    };
  }, [familyId, type, from, to]);

  const currencyTabs: CurrencyCode[] =
    rawState.status === "success" ? availableCurrencies(rawState.records) : ["TRY"];

  // Pure derived state, recomputed each render (no `useMemo` needed — see
  // `buildTrendState`'s doc comment) — no fetch here, just a re-bucket of
  // the already-fetched `rawState.records`.
  const state: TrendState = buildTrendState(rawState, granularity, from, to, selectedCurrency);

  const total =
    state.status === "success"
      ? state.buckets.reduce((sum, bucket) => sum.plus(bucket.total), new Decimal(0))
      : new Decimal(0);
  const currency = selectedCurrency;
  const Icon = isIncome ? ArrowUpRight : ArrowDownRight;
  const rangeLabel = `${rangeLabelFormatter.format(new Date(`${from}T00:00:00Z`))} – ${rangeLabelFormatter.format(new Date(`${to}T00:00:00Z`))}`;

  const bucketCount = state.status === "success" ? state.buckets.length : 0;
  const tickInterval = bucketCount <= 14 ? 0 : Math.ceil(bucketCount / 10) - 1;

  const selectedBucket =
    state.status === "success" && selectedKey ? state.buckets.find((b) => b.key === selectedKey) ?? null : null;
  const selectedDateLabel = selectedBucket
    ? granularity === "year"
      ? selectedBucket.key
      : granularity === "month"
        ? fullMonthFormatter.format(new Date(`${selectedBucket.key}-01T00:00:00Z`))
        : fullDateFormatter.format(new Date(`${selectedBucket.key}T00:00:00Z`))
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/family/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Aile işlemlerine dön
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
          Aile {isIncome ? "Geliri" : "Gideri"} — {granularityLabel(granularity, true)} Akış
        </h1>
        <p className="mt-1.5 text-muted-foreground">
          Ailenin {isIncome ? "gelirlerinin" : "giderlerinin"} seçtiğin aralıktaki{" "}
          {granularityLabel(granularity, false)} dağılımı. Bir noktaya tıklayarak o {granularity === "year" ? "yılı" : granularity === "month" ? "ayı" : "günü"} kimin ne kadar katkıyla oluşturduğunu görebilirsin.
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex flex-col gap-1.5">
          <Label id="family-trend-preset-label" className="text-xs text-muted-foreground">
            Aralık
          </Label>
          <div
            role="radiogroup"
            aria-labelledby="family-trend-preset-label"
            className="inline-flex w-fit flex-wrap rounded-lg bg-muted p-0.5"
          >
            {RANGE_PRESETS.map((preset) =>
              preset.key === "year" ? (
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
              Yıllık
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="family-trend-from" className="text-xs text-muted-foreground">
            Başlangıç
          </Label>
          <Input
            id="family-trend-from"
            type="date"
            className="w-36"
            value={from}
            max={to && to < today ? to : today}
            onChange={(event) => updateRange({ from: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="family-trend-to" className="text-xs text-muted-foreground">
            Bitiş
          </Label>
          <Input
            id="family-trend-to"
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
            <Label id="family-trend-currency-label" className="text-xs text-muted-foreground">
              Para birimi
            </Label>
            <div
              role="radiogroup"
              aria-labelledby="family-trend-currency-label"
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
            Filtreyi temizle
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 [.border-b]:pb-0">
          <div>
            <CardTitle>
              {granularityLabel(granularity, true)} {isIncome ? "gelir" : "gider"}
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
              Toplam: {formatAmount(total, currency)}
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
              <p className="text-sm text-muted-foreground">
                Bu aralıkta {isIncome ? "gelir" : "gider"} kaydı yok.
              </p>
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
                  onClick={(chartState) => {
                    // recharts v3's click payload has no `activePayload` —
                    // index into the SAME `state.buckets` array `data` above
                    // was built from (`activeTooltipIndex`, the canonical
                    // field; `activeIndex` is kept only for v2 back-compat).
                    // NOTE: despite the name, `activeTooltipIndex`'s type is
                    // `TooltipIndex = string | null` in recharts v3 (a
                    // stringified numeric index, e.g. `"3"`), NOT a `number`
                    // — verified against node_modules/recharts/types
                    // (state/tooltipSlice.d.ts) after a live Playwright
                    // check showed a plain `typeof index === "number"` guard
                    // never matching.
                    const index = chartState?.activeTooltipIndex;
                    const parsedIndex = typeof index === "string" ? Number(index) : NaN;
                    if (Number.isInteger(parsedIndex) && state.status === "success") {
                      const bucket = state.buckets[parsedIndex];
                      if (bucket) setSelectedKey(bucket.key);
                    }
                  }}
                  className="cursor-pointer"
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
                      new Intl.NumberFormat("tr-TR", { notation: "compact" }).format(value)
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
                        ? {
                            r: 3.5,
                            strokeWidth: selectedKey ? 2 : 0,
                            stroke: "var(--card)",
                            fill: isIncome ? "var(--income)" : "var(--destructive)",
                          }
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
            <div className="mt-2 flex justify-end">
              <GranularityDropdown
                trigger={
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    Görünüm: {granularity === "month" ? "Aylık" : "Günlük"}
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

      {/* Per-member drill-down — the actual feature request (2026-08-22):
          clicking a point above shows who contributed how much to it. Always
          rendered once the chart has real data, so the interaction is
          discoverable even before the first click — an empty-state hint
          rather than only appearing after. */}
      {state.status === "success" && !total.isZero() ? (
        <Card>
          <CardHeader>
            <CardTitle>{selectedBucket ? selectedDateLabel : "Üye katkısı"}</CardTitle>
            {selectedBucket ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Toplam {formatAmount(selectedBucket.total, currency)} — kimin ne kadar katkısı olduğu aşağıda.
              </p>
            ) : null}
          </CardHeader>
          <CardContent>
            {!selectedBucket ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <MousePointerClick className="size-4" strokeWidth={2} />
                </span>
                <p className="max-w-56 text-sm text-muted-foreground">
                  Yukarıdaki grafikte bir noktaya tıkla, o {granularity === "year" ? "yılı" : granularity === "month" ? "ayı" : "günü"} kimin ne kadar katkıyla oluşturduğunu burada gör.
                </p>
              </div>
            ) : selectedBucket.byMember.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">Bu {granularity === "year" ? "yılda" : granularity === "month" ? "ayda" : "günde"} kayıt yok.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {selectedBucket.byMember.map((contribution) => {
                  const share = selectedBucket.total.isZero()
                    ? 0
                    : contribution.amount.div(selectedBucket.total).times(100).toNumber();
                  return (
                    <li
                      key={contribution.userId}
                      className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5 ring-1 ring-foreground/5"
                    >
                      <Avatar size="sm">
                        <AvatarFallback>{initials(contribution.ownerName)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{contribution.ownerName}</p>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border" aria-hidden>
                          <div
                            className={cn("h-full", isIncome ? "bg-income" : "bg-destructive")}
                            style={{ width: `${share}%` }}
                          />
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <p
                          className={cn(
                            "num-tabular text-sm font-semibold",
                            isIncome ? "text-income" : "text-destructive"
                          )}
                        >
                          {formatAmount(contribution.amount, currency)}
                        </p>
                        <p className="num-tabular text-xs text-muted-foreground">
                          %{percentFormatter.format(share)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function BucketTooltip({
  active,
  payload,
  currency,
  granularity,
}: TooltipContentProps & { currency: CurrencyCode; granularity: Granularity }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload as { key: string; amount: number };
  const dateLabel =
    granularity === "year"
      ? point.key
      : granularity === "month"
        ? fullMonthFormatter.format(new Date(`${point.key}-01T00:00:00Z`))
        : fullDateFormatter.format(new Date(`${point.key}T00:00:00Z`));
  return (
    <div className="rounded-lg bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10">
      <p className="font-medium">{dateLabel}</p>
      <p className="num-tabular mt-0.5 text-muted-foreground">{formatAmount(point.amount, currency)}</p>
      <p className="mt-1 text-xs text-muted-foreground">Kim ne kadar katkı sağladı için tıkla</p>
    </div>
  );
}
