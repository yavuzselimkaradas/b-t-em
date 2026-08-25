"use client";

import { useEffect, useState } from "react";
import { Controller, useForm, useWatch, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowDownRight, ArrowUpRight, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Category } from "@prisma/client";
import type { z } from "zod";

import { cn } from "@/lib/utils";
import { CURRENCY_OPTIONS, parseLocalizedAmount } from "@/lib/domain/currency";
import { transactionSchema, type TransactionInput } from "@/lib/validation/transaction";
import type { TransactionSource } from "@/lib/client/transactions-source";
import type { TransactionViewModel } from "@/lib/client/transaction-view-model";
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
import { Textarea } from "@/components/ui/textarea";

// `z.input` (the pre-transform/pre-coerce shape), not `z.infer`
// (post-transform): the date field must accept the raw "yyyy-mm-dd" string
// a native `<input type="date">` produces, and amount must accept the raw
// text the user is typing — `transactionSchema`'s `z.coerce.date()` /
// amount transform only run when the resolver validates on submit. Using
// `z.input<typeof transactionSchema>` (rather than a hand-written type) is
// what keeps this assignable to `zodResolver(transactionSchema)`'s expected
// field-values type below.
type TransactionFormValues = z.input<typeof transactionSchema>;

/** Local calendar date (not UTC) as "yyyy-mm-dd", for defaulting a new
 * transaction's date field to "today" as the user's clock sees it. */
function todayInputValue(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Formats an existing transaction's stored date back into the date input's
 * "yyyy-mm-dd" shape. Uses UTC getters deliberately: `transactionSchema`'s
 * `z.coerce.date()` parses a date-only string as UTC midnight, so reading
 * it back with UTC (not local) getters is what round-trips correctly
 * regardless of the browser's timezone. */
function toDateInputValue(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function buildDefaultValues(transaction?: TransactionViewModel): TransactionFormValues {
  if (!transaction) {
    return {
      type: "EXPENSE",
      amount: "",
      currency: "TRY",
      categoryId: "",
      description: "",
      date: todayInputValue(),
    };
  }
  return {
    type: transaction.type,
    // `String(...)` (not `.toString()`) works whether `amount` arrives as a
    // Prisma Decimal instance or an already-serialized string/number — safe
    // regardless of how the Server Action boundary ends up encoding it.
    // Displayed with a comma decimal separator to match how a TR user
    // would type it; `parseLocalizedAmount` converts it back on submit.
    amount: String(transaction.amount).replace(".", ","),
    currency: transaction.currency,
    categoryId: transaction.categoryId,
    description: transaction.description ?? "",
    date: toDateInputValue(transaction.date),
  };
}

interface TransactionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  transaction?: TransactionViewModel;
  categories: Category[];
  /** Which backend to submit to (account Server Actions vs. the guest
   * localStorage store) — see lib/client/transactions-source.ts. The form
   * itself never imports a Server Action or the guest store directly. */
  source: TransactionSource;
  onSaved: (transaction: TransactionViewModel) => void;
}

/**
 * Dialog chrome only. `DialogContent` stays mounted for the whole lifetime
 * of the parent (needed for its open/close transition to play), but its
 * actual field content — `TransactionFormFields` — is mounted only while
 * `open`. That fully replaces what would otherwise be a
 * "reset the form whenever the dialog (re)opens" `useEffect`: instead of
 * resetting an existing form instance, a FRESH `useForm()` instance (with
 * `defaultValues` computed straight from props at mount time) is created
 * every time the dialog opens, and thrown away when it closes. No stale
 * values/errors can leak between "create", or between editing two
 * different transactions, and there's nothing to keep in sync via an
 * effect.
 */
export function TransactionForm({
  open,
  onOpenChange,
  mode,
  transaction,
  categories,
  source,
  onSaved,
}: TransactionFormProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <TransactionFormFields
            mode={mode}
            transaction={transaction}
            categories={categories}
            source={source}
            onSaved={onSaved}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TransactionFormFields({
  mode,
  transaction,
  categories,
  source,
  onSaved,
  onClose,
}: {
  mode: "create" | "edit";
  transaction: TransactionViewModel | undefined;
  categories: Category[];
  source: TransactionSource;
  onSaved: (transaction: TransactionViewModel) => void;
  onClose: () => void;
}) {
  const t = useTranslations("transactions.form");
  const tCommon = useTranslations("common");
  const [formError, setFormError] = useState<string | null>(null);

  const {
    control,
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<TransactionFormValues, unknown, TransactionInput>({
    resolver: zodResolver(transactionSchema),
    defaultValues: buildDefaultValues(transaction),
  });

  const selectedType = useWatch({ control, name: "type" });
  const selectedCategoryId = useWatch({ control, name: "categoryId" });
  const categoriesForType = categories.filter((category) => category.type === selectedType);

  // If the selected category no longer matches the selected type (user
  // switched Gelir ↔ Gider after already picking a category), clear it
  // rather than silently submitting a mismatched pair the server would
  // reject anyway.
  useEffect(() => {
    if (selectedCategoryId && !categoriesForType.some((c) => c.id === selectedCategoryId)) {
      setValue("categoryId", "", { shouldValidate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType]);

  const onSubmit: SubmitHandler<TransactionInput> = async (values) => {
    setFormError(null);
    try {
      const result =
        mode === "create" ? await source.create(values) : await source.update(transaction!.id, values);

      if (!result.success) {
        setFormError(result.error);
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            if (messages?.[0]) {
              setError(field as keyof TransactionInput, { message: messages[0] });
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
          {mode === "create" ? t("createDescription") : t("editDescription")}
        </DialogDescription>
      </DialogHeader>

      <form
        id="transaction-form"
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        className="flex flex-col gap-4"
      >
        <FormAlert message={formError} />

        <Controller
          control={control}
          name="type"
          render={({ field }) => (
            <div className="flex flex-col gap-1.5">
              <Label id="transaction-type-label">{t("typeLabel")}</Label>
              <div
                role="radiogroup"
                aria-labelledby="transaction-type-label"
                className="grid grid-cols-2 gap-2"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={field.value === "INCOME"}
                  onClick={() => field.onChange("INCOME")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    field.value === "INCOME"
                      ? "border-income/30 bg-income-soft text-income"
                      : "border-border text-muted-foreground hover:bg-muted"
                  )}
                >
                  <ArrowUpRight className="size-4" strokeWidth={2.5} />
                  {t("income")}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={field.value === "EXPENSE"}
                  onClick={() => field.onChange("EXPENSE")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    field.value === "EXPENSE"
                      ? "border-destructive/30 bg-destructive/10 text-destructive"
                      : "border-border text-muted-foreground hover:bg-muted"
                  )}
                >
                  <ArrowDownRight className="size-4" strokeWidth={2.5} />
                  {t("expense")}
                </button>
              </div>
              <FieldError message={errors.type?.message} />
            </div>
          )}
        />

        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="amount">{t("amountLabel")}</Label>
            <Input
              id="amount"
              type="text"
              inputMode="decimal"
              placeholder="0,00"
              aria-invalid={!!errors.amount}
              {...register("amount", {
                setValueAs: (value: string) => parseLocalizedAmount(value),
              })}
            />
            <FieldError message={errors.amount?.message} />
          </div>

          <Controller
            control={control}
            name="currency"
            render={({ field }) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="currency">{t("currencyLabel")}</Label>
                <Select value={field.value} onValueChange={field.onChange} name={field.name}>
                  <SelectTrigger id="currency" className="w-18" aria-invalid={!!errors.currency}>
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

        <Controller
          control={control}
          name="categoryId"
          render={({ field }) => (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="categoryId">{t("categoryLabel")}</Label>
              {/* `field.value || null` (not the raw `""` RHF/Zod use for
                  "empty"): Base UI's Select only renders its placeholder
                  when `value` is `null` — an empty *string* is treated as a
                  real, just-unmatched selection, which left the trigger
                  blank instead of showing "Kategori seç". `?? ""` on the
                  way back keeps the field itself a plain string, matching
                  what `categoryIdSchema` (a cuid string) expects. */}
              <Select
                value={field.value || null}
                onValueChange={(value) => field.onChange(value ?? "")}
                name={field.name}
              >
                <SelectTrigger id="categoryId" className="w-full" aria-invalid={!!errors.categoryId}>
                  {/* Render-prop (not just `placeholder`): Base UI's
                      <Select.Value> shows the raw stored value until the
                      popup has opened once — without this, editing a
                      transaction would briefly show its category's raw id
                      instead of its name. */}
                  {/* A `children` render-prop entirely replaces Base UI's
                      own placeholder handling (per its own docs), so the
                      "no category selected yet" case has to be handled
                      inside the function too, not left to `placeholder`. */}
                  <SelectValue placeholder={t("categoryPlaceholder")}>
                    {(value: string | null) =>
                      (value && categoriesForType.find((c) => c.id === value)?.name) ||
                      t("categoryPlaceholder")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {categoriesForType.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">
                      {t("noCategoriesForType")}
                    </p>
                  ) : (
                    categoriesForType.map((category) => (
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

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">{t("dateLabel")}</Label>
          {/* Future-dated income/expense is disabled (product decision — a
              transaction records something that happened) — `max` blocks
              picking one in the browser's native date picker, and
              `transactionSchema`'s dateSchema rejects it server-side too
              even if this attribute is bypassed. */}
          <Input
            id="date"
            type="date"
            max={todayInputValue()}
            aria-invalid={!!errors.date}
            {...register("date")}
          />
          <FieldError message={errors.date?.message} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="description">{t("descriptionLabel")}</Label>
          <Textarea
            id="description"
            rows={2}
            placeholder={t("descriptionPlaceholder")}
            aria-invalid={!!errors.description}
            {...register("description")}
          />
          <FieldError message={errors.description?.message} />
        </div>
      </form>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" form="transaction-form" disabled={isSubmitting}>
          {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {mode === "create" ? t("submitCreate") : t("submitEdit")}
        </Button>
      </DialogFooter>
    </>
  );
}
