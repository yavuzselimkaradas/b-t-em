"use client";

import { useState } from "react";
import { Controller, useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import type { Category } from "@prisma/client";
import type { z } from "zod";

import { cn } from "@/lib/utils";
import { CURRENCY_OPTIONS, parseLocalizedAmount } from "@/lib/domain/currency";
import { budgetSchema, type BudgetInput } from "@/lib/validation/budget";
import {
  createBudget,
  updateBudget,
  type BudgetRow,
  type BudgetScope,
} from "@/lib/server/actions/budgets";
import { useScopedTranslations } from "@/lib/client/use-scoped-translations";
import { getCategoryVisual } from "@/components/transactions/category-visual";
import { FieldError, FormAlert } from "@/components/auth/form-elements";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Same field markup/wiring style as family-transaction-form.tsx (single
// useForm, one Dialog wrapper that only mounts its fields component while
// `open` — resets state per open/close instead of a manual `reset()` call).
// A separate component from that one, not a shared abstraction: a budget
// limit has no `type`/`date`/`description`, and its category is fixed after
// creation, so the field set genuinely differs rather than being a subset.

type BudgetFormValues = z.input<typeof budgetSchema>;

function buildDefaultValues(mode: "create" | "edit", budget?: BudgetRow): BudgetFormValues {
  if (mode === "edit" && budget) {
    return {
      categoryId: budget.categoryId,
      limitAmount: String(budget.limitAmount).replace(".", ","),
      currency: budget.currency,
    };
  }
  return { categoryId: "", limitAmount: "", currency: "TRY" };
}

interface BudgetFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  scope: BudgetScope;
  /** Already filtered to `type === "EXPENSE"` by the caller (BudgetList) —
   * see CLAUDE.md task brief: only gider categories may carry a limit. */
  categories: Category[];
  /** categoryId's that already have a budget in this scope — excluded from
   * the CREATE dropdown so a duplicate-limit error is avoided up front
   * rather than only caught after submit (the backend still enforces this
   * with `DUPLICATE_MESSAGE` as the source of truth; this is just a better
   * first attempt). Ignored in edit mode. */
  existingCategoryIds: string[];
  budget?: BudgetRow;
  onSaved: (row: BudgetRow) => void;
}

export function BudgetFormDialog({
  open,
  onOpenChange,
  mode,
  scope,
  categories,
  existingCategoryIds,
  budget,
  onSaved,
}: BudgetFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <BudgetFormFields
            mode={mode}
            scope={scope}
            categories={categories}
            existingCategoryIds={existingCategoryIds}
            budget={budget}
            onSaved={onSaved}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function BudgetFormFields({
  mode,
  scope,
  categories,
  existingCategoryIds,
  budget,
  onSaved,
  onClose,
}: {
  mode: "create" | "edit";
  scope: BudgetScope;
  categories: Category[];
  existingCategoryIds: string[];
  budget: BudgetRow | undefined;
  onSaved: (row: BudgetRow) => void;
  onClose: () => void;
}) {
  // Individual scope (`/budgets`) tracks the active locale; family scope
  // (`/family/budgets`) stays pinned to Turkish — see
  // `useScopedTranslations`'s doc comment.
  const isIndividual = scope === "individual";
  const t = useScopedTranslations("budgets.formDialog", isIndividual);
  const tCommon = useScopedTranslations("common", isIndividual);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    control,
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<BudgetFormValues, unknown, BudgetInput>({
    resolver: zodResolver(budgetSchema),
    defaultValues: buildDefaultValues(mode, budget),
  });

  // Create mode only offers categories that don't already have a limit —
  // edit mode never shows the picker at all (category is fixed once set).
  const alreadyBudgeted = new Set(existingCategoryIds);
  const availableCategories = categories.filter((category) => !alreadyBudgeted.has(category.id));

  const onSubmit: SubmitHandler<BudgetInput> = async (values) => {
    setFormError(null);
    try {
      const result =
        mode === "create"
          ? await createBudget(values, scope)
          : await updateBudget(budget!.id, { limitAmount: values.limitAmount, currency: values.currency });

      if (!result.success) {
        setFormError(result.error);
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            if (messages?.[0]) {
              setError(field as keyof BudgetInput, { message: messages[0] });
            }
          }
        }
        return;
      }

      onSaved(result.data);
      onClose();
    } catch {
      setFormError(tCommon("somethingWrong"));
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === "create" ? t("createTitle") : t("editTitle")}</DialogTitle>
        <DialogDescription>
          {mode === "create"
            ? t("createDescription")
            : t("editDescription", { category: budget?.category.name ?? "" })}
        </DialogDescription>
      </DialogHeader>

      <form
        id="budget-form"
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        className="flex flex-col gap-4"
      >
        <FormAlert message={formError} />

        {mode === "create" ? (
          <Controller
            control={control}
            name="categoryId"
            render={({ field }) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="budget-categoryId">{t("categoryLabel")}</Label>
                <Select
                  value={field.value || null}
                  onValueChange={(value) => field.onChange(value ?? "")}
                  name={field.name}
                >
                  <SelectTrigger id="budget-categoryId" className="w-full" aria-invalid={!!errors.categoryId}>
                    <SelectValue placeholder={t("categoryPlaceholder")}>
                      {(value: string | null) =>
                        (value && availableCategories.find((c) => c.id === value)?.name) ||
                        t("categoryPlaceholder")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {availableCategories.length === 0 ? (
                      <p className="px-2 py-1.5 text-sm text-muted-foreground">
                        {t("noCategoriesLeft")}
                      </p>
                    ) : (
                      availableCategories.map((category) => (
                        <SelectItem key={category.id} value={category.id}>
                          {category.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <FieldError message={errors.categoryId?.message} />
              </div>
            )}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label>{t("categoryLabel")}</Label>
            <CategoryReadout category={budget!.category} />
            <p className="text-xs text-muted-foreground">{t("categoryLocked")}</p>
          </div>
        )}

        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="budget-amount">{t("amountLabel")}</Label>
            <Input
              id="budget-amount"
              type="text"
              inputMode="decimal"
              placeholder="0,00"
              aria-invalid={!!errors.limitAmount}
              {...register("limitAmount", {
                setValueAs: (value: string) => parseLocalizedAmount(value),
              })}
            />
            <FieldError message={errors.limitAmount?.message} />
          </div>

          <Controller
            control={control}
            name="currency"
            render={({ field }) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="budget-currency">{t("currencyLabel")}</Label>
                <Select value={field.value} onValueChange={field.onChange} name={field.name}>
                  <SelectTrigger id="budget-currency" className="w-18" aria-invalid={!!errors.currency}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          />
        </div>
      </form>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button
          type="submit"
          form="budget-form"
          disabled={isSubmitting || (mode === "create" && availableCategories.length === 0)}
        >
          {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {mode === "create" ? t("submitCreate") : t("submitEdit")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Read-only category chip for the edit dialog — same icon/chip look as the
 * list row, so the fixed category still reads as "the same thing" between
 * the two views. */
function CategoryReadout({ category }: { category: Category }) {
  const visual = getCategoryVisual(category);
  const Icon = visual.icon;
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/50 px-3 py-2">
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full", visual.bg, visual.fg)}>
        <Icon className="size-3.5" strokeWidth={2.25} />
      </span>
      <span className="font-medium text-foreground">{category.name}</span>
    </div>
  );
}
