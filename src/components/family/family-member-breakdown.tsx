"use client";

import Decimal from "decimal.js";
import { AlertCircle, ArrowDownRight, ArrowUpRight } from "lucide-react";

import type { FamilyMemberBreakdownRow } from "@/lib/server/actions/family-transactions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiCurrencyAmount } from "@/components/transactions/multi-currency-amount";

export type FamilyBreakdownState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; rows: FamilyMemberBreakdownRow[] };

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const letters = parts.map((part) => part[0]?.toUpperCase()).join("");
  return letters || "?";
}

/**
 * "Kim ne kadar kazanmış/harcamış" — one card per row of
 * `familyMemberBreakdown`. Deliberately a plain card grid, not a chart (the
 * roadmap's brief for this screen asks for exactly that) — the one bit of
 * visual magnitude comparison this adds beyond raw numbers is the thin
 * two-segment bar per card (income share vs. expense share of that member's
 * own total activity), reusing the app's already-established income/
 * destructive tokens rather than introducing a new categorical palette.
 */
export function FamilyMemberBreakdown({
  state,
  currentUserId,
}: {
  state: FamilyBreakdownState;
  currentUserId: string | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Üye bazlı dağılım</CardTitle>
      </CardHeader>
      <CardContent>
        {state.status === "error" ? (
          <p className="flex items-center gap-2 py-4 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            {state.message}
          </p>
        ) : state.status === "loading" ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-28 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : state.rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Bu aralıkta işlem yok.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {state.rows.map((row) => (
              <MemberCard key={row.userId} row={row} isCurrentUser={row.userId === currentUserId} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MemberCard({ row, isCurrentUser }: { row: FamilyMemberBreakdownRow; isCurrentUser: boolean }) {
  // The income-vs-expense share bar below needs ONE number to split into two
  // segments — computed from the TRY entry only (always present in
  // `row.totals`, per `summarize`'s zero-fill rule), never a cross-currency
  // sum, matching this feature's "no conversion for total rows" rule
  // (design decision #4) and the same TRY-only convention
  // `familyMemberBreakdown`'s own sort already uses server-side (see that
  // action's doc comment). A member who only ever logs USD/EUR shows a
  // neutral 50/50 bar here (their real figures are still fully visible in
  // the amount rows below, per currency) — an accepted, deliberately
  // TRY-scoped visual, not a bug.
  const tryTotals = row.totals.find((entry) => entry.currency === "TRY");
  const tryIncome = new Decimal(tryTotals?.totalIncome ?? "0");
  const tryExpense = new Decimal(tryTotals?.totalExpense ?? "0");
  const tryActivity = tryIncome.plus(tryExpense);
  const incomeShare = tryActivity.isZero() ? 50 : tryIncome.div(tryActivity).times(100).toNumber();

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3.5 ring-1 ring-foreground/5">
      <div className="flex items-center gap-2.5">
        <Avatar size="sm">
          <AvatarFallback>{initials(row.userName)}</AvatarFallback>
        </Avatar>
        <p className="min-w-0 truncate text-sm font-medium text-foreground">
          {row.userName}
          {isCurrentUser ? <span className="font-normal text-muted-foreground"> (Siz)</span> : null}
        </p>
      </div>

      <div className="flex flex-col gap-1.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-muted-foreground">
            <ArrowUpRight className="size-3.5 text-income" strokeWidth={2.5} />
            Gelir
          </span>
          <MultiCurrencyAmount rows={row.totals} field="totalIncome" size="sm" />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-muted-foreground">
            <ArrowDownRight className="size-3.5 text-destructive" strokeWidth={2.5} />
            Gider
          </span>
          <MultiCurrencyAmount rows={row.totals} field="totalExpense" size="sm" />
        </div>
      </div>

      {/* Thin income-vs-expense share bar — pure magnitude comparison for
          THIS member's own TRY activity (see the TRY-only note above), not a
          comparison across members (each card's bar is independently scaled
          to its own income+expense total), so it stays meaningful even when
          members' totals are very different sizes. */}
      <div className="flex h-1.5 overflow-hidden rounded-full bg-border" aria-hidden>
        <div className="h-full bg-income" style={{ width: `${incomeShare}%` }} />
        <div className="h-full bg-destructive" style={{ width: `${100 - incomeShare}%` }} />
      </div>

      <div className="flex items-center justify-between border-t border-border pt-2.5 text-sm">
        <span className="font-medium text-foreground">Net</span>
        <MultiCurrencyAmount rows={row.totals} field="net" size="sm" />
      </div>
    </div>
  );
}
