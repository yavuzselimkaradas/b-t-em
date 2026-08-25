// UI-only status → label/icon/color mapping for a Budget's `status`
// ("ok"/"warning"/"exceeded" — lib/domain/budgets/evaluate.ts). Deliberately
// NOT in lib/domain (renders lucide-react components, same reasoning as
// category-visual.ts). Colors always pair with an icon here (proje
// dokümanı §8 — never color alone), and the palette matches the
// income/warning/destructive token triad in globals.css exactly: "ok"
// reuses the income green (a healthy budget reads the same as a positive
// transaction), "warning" is the new amber token, "exceeded" reuses
// destructive red (same register as an expense/error).
import { AlertCircle, CheckCircle2, TriangleAlert, type LucideIcon } from "lucide-react";

import type { BudgetStatus } from "@/lib/domain/budgets";

export interface BudgetStatusMeta {
  /** Key under the `budgets.status` message namespace — a plain object like
   * this one can't call `useTranslations` itself, so `budget-list.tsx`
   * (the only consumer) resolves it via `t(statusMeta.labelKey)`. */
  labelKey: "ok" | "warning" | "exceeded";
  icon: LucideIcon;
  /** Text color for the spent amount / percentage figure. */
  textClass: string;
  /** Progress bar fill color. */
  indicatorClass: string;
  /** Status pill background+text. */
  badgeClass: string;
}

export const BUDGET_STATUS_META: Record<BudgetStatus, BudgetStatusMeta> = {
  ok: {
    labelKey: "ok",
    icon: CheckCircle2,
    textClass: "text-income",
    indicatorClass: "bg-income",
    badgeClass: "bg-income-soft text-income",
  },
  warning: {
    labelKey: "warning",
    icon: TriangleAlert,
    textClass: "text-warning",
    indicatorClass: "bg-warning",
    badgeClass: "bg-warning-soft text-warning",
  },
  exceeded: {
    labelKey: "exceeded",
    icon: AlertCircle,
    textClass: "text-destructive",
    indicatorClass: "bg-destructive",
    badgeClass: "bg-destructive/10 text-destructive",
  },
};
