// Framework-agnostic budget-limit math. No Next.js / Prisma imports here —
// this module is shared between the web app (src/lib/server/**) and the
// future mobile client (see barrel comment in lib/domain/index.ts).
import Decimal from "decimal.js";

/**
 * Where a Budget's current-month spend sits relative to its limit.
 *  - "ok": under the warning threshold.
 *  - "warning": at/above 80% of the limit but still under 100%.
 *  - "exceeded": at/above 100% of the limit.
 */
export type BudgetStatus = "ok" | "warning" | "exceeded";

// Product/dataviz convention (not a DB-configurable value, same "fixed
// constant" treatment as e.g. transaction.ts's MAX_FUTURE_DAYS): 80% is a
// reasonable generic "approaching the limit" signal.
const WARNING_THRESHOLD_PERCENTAGE = 80;
const EXCEEDED_THRESHOLD_PERCENTAGE = 100;

export interface BudgetEvaluation {
  status: BudgetStatus;
  /** 0+ (uncapped — can exceed 100 when spend is over the limit), rounded to
   * nothing here; callers display it as-is. */
  percentage: number;
}

/**
 * Computes how a given spend compares to a limit. Pure and synchronous, same
 * `decimal.js` discipline as lib/domain/transactions/aggregate.ts — never
 * routes a money value through `number`/`Float` arithmetic before this final
 * display-only conversion.
 *
 * `limitAmount` of 0 (should not occur in practice — `budgetSchema` requires
 * a positive amount — but defensive here since this is a pure function
 * reachable from anywhere) returns `{ status: "ok", percentage: 0 }` rather
 * than dividing by zero.
 */
export function evaluateBudgetStatus(
  limitAmount: Decimal.Value,
  spentAmount: Decimal.Value
): BudgetEvaluation {
  const limit = new Decimal(limitAmount);
  const spent = new Decimal(spentAmount);

  if (limit.isZero() || limit.isNegative()) {
    return { status: "ok", percentage: 0 };
  }

  const percentage = spent.dividedBy(limit).times(100).toNumber();

  let status: BudgetStatus;
  if (percentage >= EXCEEDED_THRESHOLD_PERCENTAGE) {
    status = "exceeded";
  } else if (percentage >= WARNING_THRESHOLD_PERCENTAGE) {
    status = "warning";
  } else {
    status = "ok";
  }

  return { status, percentage };
}

/**
 * A caller's scope when creating/updating/deleting a Budget — mirrors the
 * XOR shape of `Budget.userId`/`Budget.familyId` in schema.prisma (enforced
 * there by the `budget_owner_xor` CHECK constraint).
 */
export type BudgetManageScope =
  | { type: "individual" }
  | { type: "family"; actorFamilyRole: "OWNER" | "MEMBER" | null };

/**
 * Pure authorization predicate for "may the caller create/update/delete a
 * Budget in this scope?" — the domain-layer equivalent of
 * `canMutateTransaction` in lib/domain/transactions/authorization.ts.
 *
 * Product decision (roadmap Aşama 6, approved): "Sadece owner (veya bireysel
 * kullanıcı) limit oluşturabilir" — individual budgets have exactly one
 * possible actor (the caller already IS the `userId` the budget would be
 * scoped to, enforced upstream by deriving `userId` from the session, never
 * from input), so `type: "individual"` is always `true` here. Family budgets
 * are OWNER-only — a MEMBER (or someone with no role at all, `null`, e.g. not
 * actually a member of that family) may only ever VIEW them via
 * `listBudgets`, never create/update/delete.
 *
 * Kept as a plain function over plain data (no DB, no Next.js) so it's
 * unit-testable in isolation, same reasoning as `canMutateTransaction`.
 */
export function canManageBudget(scope: BudgetManageScope): boolean {
  if (scope.type === "individual") {
    return true;
  }
  return scope.actorFamilyRole === "OWNER";
}
