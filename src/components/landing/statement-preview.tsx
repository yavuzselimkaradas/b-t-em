import { ArrowDownRight, ArrowUpRight } from "lucide-react";

import { cn } from "@/lib/utils";

const ROWS = [
  { label: "Maaş", category: "Gelir", amount: "+₺48.500,00", kind: "income" },
  { label: "Kira", category: "Konut", amount: "-₺14.000,00", kind: "expense" },
  { label: "Market", category: "Gıda", amount: "-₺6.240,00", kind: "expense" },
  { label: "Abonelikler", category: "Eğlence", amount: "-₺389,00", kind: "expense" },
] as const;

/**
 * Decorative, static "statement" card for the landing hero — grounds the
 * page in the actual product (a ledger of income/expense rows) instead of
 * an abstract illustration. Not real data; not interactive.
 */
export function StatementPreview({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "w-full max-w-sm rounded-2xl bg-card p-5 shadow-xl ring-1 ring-foreground/10",
        className
      )}
    >
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div>
          <p className="text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
            Ağustos 2026
          </p>
          <p className="font-display text-lg font-semibold text-foreground">Aylık özet</p>
        </div>
        <span className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand-soft-foreground">
          Dengede
        </span>
      </div>

      <ul className="mt-1 flex flex-col divide-y divide-border">
        {ROWS.map((row) => (
          <li key={row.label} className="flex items-center justify-between gap-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full",
                  row.kind === "income"
                    ? "bg-income-soft text-income"
                    : "bg-destructive/10 text-destructive"
                )}
              >
                {row.kind === "income" ? (
                  <ArrowUpRight className="size-3.5" strokeWidth={2.5} />
                ) : (
                  <ArrowDownRight className="size-3.5" strokeWidth={2.5} />
                )}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{row.label}</p>
                <p className="truncate text-xs text-muted-foreground">{row.category}</p>
              </div>
            </div>
            <span
              className={cn(
                "num-tabular shrink-0 text-sm font-medium",
                row.kind === "income" ? "text-income" : "text-destructive"
              )}
            >
              {row.amount}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-1 flex items-center justify-between border-t border-border pt-3">
        <span className="text-sm font-medium text-foreground">Kalan bakiye</span>
        <span className="num-tabular text-base font-semibold text-foreground">₺27.871,00</span>
      </div>
    </div>
  );
}
