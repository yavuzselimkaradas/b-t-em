"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, MoreVertical, Pencil, PiggyBank, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { Category } from "@prisma/client";

import { cn } from "@/lib/utils";
import { formatAmount } from "@/lib/domain/currency";
import { listCategories } from "@/lib/server/actions/categories";
import { listBudgets, type BudgetRow } from "@/lib/server/actions/budgets";
import { getCategoryVisual } from "@/components/transactions/category-visual";
import { BUDGET_STATUS_META } from "@/components/budgets/budget-status";
import { BudgetFormDialog } from "@/components/budgets/budget-form-dialog";
import { DeleteBudgetDialog } from "@/components/budgets/delete-budget-dialog";
import { useScopedTranslations } from "@/lib/client/use-scoped-translations";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; items: BudgetRow[] };

/**
 * A resolved scope — unlike `BudgetScope` in lib/server/actions/budgets.ts
 * (whose `familyId: unknown` exists purely because a Server Action is a
 * reachable network endpoint and must validate its own input), the PAGE
 * calling this component has already resolved a real family id via
 * `getMyFamily()`, so this component's own prop contract can be the
 * narrower, string-typed shape. Still structurally assignable to
 * `BudgetScope` wherever it's forwarded to a Server Action.
 */
type ResolvedBudgetScope = "individual" | { familyId: string };

interface BudgetListProps {
  /** `"individual"` (own budgets, `/budgets`) or `{ familyId }`
   * (`/family/budgets`, any member may view). Passed straight through to
   * `listBudgets`/`createBudget` — never re-derived here. */
  scope: ResolvedBudgetScope;
  /** Individual scope: always `true`. Family scope: only the family's
   * OWNER — the caller (the page) already resolved this via `getMyFamily`,
   * this component just hides/shows mutation UI accordingly. The backend
   * enforces the real rule regardless (see budgets.ts's doc comments) —
   * this is cosmetic, matching CLAUDE.md's "yetkilendirme her zaman sunucu
   * tarafında" note. */
  canManage: boolean;
}

/**
 * Shared list + create/edit/delete UI for a Budget scope — the body of both
 * `/budgets` and `/family/budgets`. Owns its own data fetching (this is a
 * Client Component rendered under a Server Component shell, same split as
 * `FamilyDashboard`), so the two pages differ only in the `scope`/
 * `canManage` they pass in plus their own header/back-link chrome.
 */
export function BudgetList({ scope, canManage }: BudgetListProps) {
  // Individual scope (`/budgets`) tracks the active locale; family scope
  // (`/family/budgets`) stays pinned to Turkish — see
  // `useScopedTranslations`'s doc comment.
  const isIndividual = scope === "individual";
  const t = useScopedTranslations("budgets.list", isIndividual);
  const [listState, setListState] = useState<ListState>({ status: "loading" });
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);

  const [formState, setFormState] = useState<{
    open: boolean;
    mode: "create" | "edit";
    budget?: BudgetRow;
  }>({ open: false, mode: "create" });
  const [deleteTarget, setDeleteTarget] = useState<BudgetRow | null>(null);

  const familyId = typeof scope === "object" ? scope.familyId : undefined;

  // Fetches without resetting to "loading" first — used by the mount effect
  // below (via the `Promise.resolve().then()` indirection, so the "loading"
  // reset lands in a microtask rather than synchronously in the effect body
  // — same discipline as `FamilyDashboard`'s summary/breakdown effects) and
  // reused as-is by `retry`, which sets "loading" itself first since it
  // runs from a click handler, not an effect.
  const fetchList = useCallback(async () => {
    try {
      const result = await listBudgets(scope);
      if (!result.success) {
        setListState({ status: "error", message: result.error });
        return;
      }
      setListState({ status: "success", items: result.data });
    } catch {
      setListState({
        status: "error",
        message: t("loadErrorFallback"),
      });
    }
    // `scope` is either the literal "individual" or a `{ familyId }` object
    // the page constructs once per render — stable enough for this effect's
    // purposes (the page itself never re-renders this prop mid-session).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope === "individual" ? "individual" : scope.familyId]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setListState({ status: "loading" });
      fetchList();
    });
    return () => {
      cancelled = true;
    };
  }, [fetchList]);

  const retry = useCallback(() => {
    setListState({ status: "loading" });
    fetchList();
  }, [fetchList]);

  // Only fetched for `canManage` — a non-owner family member can't open the
  // create dialog anyway, so there's nothing to populate the picker with.
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    listCategories(familyId).then((result) => {
      if (cancelled) return;
      if (!result.success) {
        setCategoriesError(result.error);
        return;
      }
      // Budget limits are only meaningful against gider (EXPENSE)
      // categories — see budgets.ts's CATEGORY_TYPE_MISMATCH_MESSAGE.
      setCategories(result.data.filter((category) => category.type === "EXPENSE"));
    });
    return () => {
      cancelled = true;
    };
  }, [canManage, familyId]);

  function openCreateDialog() {
    setFormState({ open: true, mode: "create" });
  }
  function openEditDialog(budget: BudgetRow) {
    setFormState({ open: true, mode: "edit", budget });
  }

  function handleSaved(row: BudgetRow) {
    setListState((prev) => {
      if (prev.status !== "success") return { status: "success", items: [row] };
      const exists = prev.items.some((b) => b.id === row.id);
      return {
        status: "success",
        items: exists ? prev.items.map((b) => (b.id === row.id ? row : b)) : [...prev.items, row],
      };
    });
  }

  function handleDeleted(id: string) {
    setListState((prev) =>
      prev.status === "success" ? { status: "success", items: prev.items.filter((b) => b.id !== id) } : prev
    );
  }

  if (listState.status === "loading") {
    return <BudgetListSkeleton />;
  }

  if (listState.status === "error") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl bg-card py-14 text-center ring-1 ring-foreground/10">
        <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertCircle className="size-6" strokeWidth={2} />
        </span>
        <div>
          <p className="font-medium text-foreground">{t("loadErrorTitle")}</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{listState.message}</p>
        </div>
        <Button variant="outline" onClick={retry}>
          <RefreshCw className="size-3.5" />
          {t("retry")}
        </Button>
      </div>
    );
  }

  const items = listState.items;
  const existingCategoryIds = items.map((b) => b.categoryId);

  return (
    <div className="flex flex-col gap-4">
      {categoriesError ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {t("categoriesLoadError", { message: categoriesError })}
        </div>
      ) : null}

      {canManage && items.length > 0 ? (
        <div className="flex justify-end">
          <Button onClick={openCreateDialog}>
            <Plus className="size-4" />
            {t("newLimit")}
          </Button>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border bg-transparent py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand-soft-foreground">
            <PiggyBank className="size-6" strokeWidth={2} />
          </span>
          <div>
            <p className="font-medium text-foreground">{t("emptyTitle")}</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {canManage ? t("emptyBodyManage") : t("emptyBodyView")}
            </p>
            {canManage ? (
              <Button className="mt-4" onClick={openCreateDialog}>
                <Plus className="size-4" />
                {t("emptyCta")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((budget) => (
            <BudgetRowCard
              key={budget.id}
              budget={budget}
              canManage={canManage}
              isIndividual={isIndividual}
              onEdit={() => openEditDialog(budget)}
              onDelete={() => setDeleteTarget(budget)}
            />
          ))}
        </div>
      )}

      <BudgetFormDialog
        open={formState.open}
        onOpenChange={(open) => setFormState((s) => ({ ...s, open }))}
        mode={formState.mode}
        scope={scope}
        categories={categories}
        existingCategoryIds={existingCategoryIds}
        budget={formState.budget}
        onSaved={handleSaved}
      />

      {deleteTarget ? (
        <DeleteBudgetDialog
          open={Boolean(deleteTarget)}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          budgetId={deleteTarget.id}
          categoryName={deleteTarget.category.name}
          isIndividual={isIndividual}
          onDeleted={handleDeleted}
        />
      ) : null}
    </div>
  );
}

function BudgetRowCard({
  budget,
  canManage,
  isIndividual,
  onEdit,
  onDelete,
}: {
  budget: BudgetRow;
  canManage: boolean;
  isIndividual: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useScopedTranslations("budgets.list", isIndividual);
  const tStatus = useScopedTranslations("budgets.status", isIndividual);
  const visual = getCategoryVisual(budget.category);
  const Icon = visual.icon;
  const statusMeta = BUDGET_STATUS_META[budget.status];
  const StatusIcon = statusMeta.icon;
  // Fill is capped at 100% visually (an over-limit bar shouldn't overflow
  // its track) — the actual percentage (which can exceed 100) is still
  // shown as text below.
  const fillPercentage = Math.min(budget.percentage, 100);

  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full",
              visual.bg,
              visual.fg
            )}
          >
            <Icon className="size-4.5" strokeWidth={2.25} />
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{budget.category.name}</p>
            <p className="text-xs text-muted-foreground">{t("monthlyLimit")}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
              statusMeta.badgeClass
            )}
          >
            <StatusIcon className="size-3" strokeWidth={2.5} />
            {tStatus(statusMeta.labelKey)}
          </span>

          {canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("optionsAria", { category: budget.category.name })}
                  >
                    <MoreVertical />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil className="size-4" />
                  {t("edit")}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                  <Trash2 className="size-4" />
                  {t("delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-2">
        <span className={cn("num-tabular text-lg font-semibold", statusMeta.textClass)}>
          {formatAmount(budget.spentThisMonth, budget.currency)}
        </span>
        <span className="num-tabular text-sm text-muted-foreground">
          / {formatAmount(budget.limitAmount, budget.currency)}
        </span>
      </div>

      <Progress
        value={fillPercentage}
        aria-label={t("progressAria", {
          category: budget.category.name,
          percent: Math.round(budget.percentage),
        })}
        className="mt-2.5"
        indicatorClassName={statusMeta.indicatorClass}
      />
      <p className="num-tabular mt-1.5 text-right text-xs text-muted-foreground">
        {t("percentageUsed", { percent: Math.round(budget.percentage) })}
      </p>
    </div>
  );
}

function BudgetListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="size-9 animate-pulse rounded-full bg-muted" />
              <div className="h-4 w-28 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
          </div>
          <div className="mt-4 h-5 w-32 animate-pulse rounded bg-muted" />
          <div className="mt-2.5 h-1 w-full animate-pulse rounded-full bg-muted" />
        </div>
      ))}
    </div>
  );
}
