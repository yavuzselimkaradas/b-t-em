"use client";

import { useEffect, useState } from "react";
import { Controller, useForm, useWatch, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowDownRight, ArrowUpRight, Loader2 } from "lucide-react";
import type { Category } from "@prisma/client";
import type { z } from "zod";

import { cn } from "@/lib/utils";
import { CURRENCY_OPTIONS, parseLocalizedAmount } from "@/lib/domain/currency";
import { transactionSchema, type TransactionInput } from "@/lib/validation/transaction";
import { createTransaction, updateTransaction } from "@/lib/server/actions/transactions";
import type { FamilyTransactionRow } from "@/lib/server/actions/family-transactions";
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

// This is a SEPARATE component from transactions/transaction-form.tsx, not a
// re-export/extension of it — that component takes a `TransactionSource`
// (account Server Actions OR the guest localStorage store), but a family
// transaction has no guest equivalent (a family plan inherently requires an
// account — see CLAUDE.md "Misafir modu") and always calls
// `createTransaction`/`updateTransaction` directly with a `familyId`. Field
// markup below is intentionally identical to transaction-form.tsx's for a
// consistent look; only the submit wiring differs.

type TransactionFormValues = z.input<typeof transactionSchema>;

function todayInputValue(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Same UTC-getter round-trip as transaction-form.tsx's `toDateInputValue` —
 * see that file's comment for why UTC (not local) getters are required
 * here. */
function toDateInputValue(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function buildDefaultValues(
  mode: "create" | "edit",
  familyId: string,
  transaction?: FamilyTransactionRow
): TransactionFormValues {
  if (!transaction) {
    return {
      type: "EXPENSE",
      amount: "",
      currency: "TRY",
      categoryId: "",
      description: "",
      date: todayInputValue(),
      // Only a CREATE carries `familyId` — `transactionUpdateSchema` omits
      // it entirely (re-attributing an existing transaction between
      // individual/family is out of scope, see that schema's doc comment),
      // so sending it on an edit would be silently dropped anyway; kept out
      // here for clarity.
      familyId,
    };
  }
  return {
    type: transaction.type,
    amount: String(transaction.amount).replace(".", ","),
    currency: transaction.currency,
    categoryId: transaction.categoryId,
    description: transaction.description ?? "",
    date: toDateInputValue(transaction.date),
    familyId: mode === "create" ? familyId : undefined,
  };
}

interface FamilyTransactionFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  familyId: string;
  transaction?: FamilyTransactionRow;
  categories: Category[];
  /** No `data` payload on purpose — `createTransaction`/`updateTransaction`
   * return a `SerializedTransaction`, which has no `ownerName` (see
   * `FamilyTransactionRow`'s doc comment), so there is nothing this form
   * could hand back that the list could render directly. The parent
   * (`FamilyDashboard`) just refetches summary/breakdown/list on save —
   * simpler than partially patching local state, and correct regardless of
   * whether summary/breakdown totals were also affected by the change. */
  onSaved: () => void;
}

export function FamilyTransactionForm({
  open,
  onOpenChange,
  mode,
  familyId,
  transaction,
  categories,
  onSaved,
}: FamilyTransactionFormProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <FamilyTransactionFormFields
            mode={mode}
            familyId={familyId}
            transaction={transaction}
            categories={categories}
            onSaved={onSaved}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FamilyTransactionFormFields({
  mode,
  familyId,
  transaction,
  categories,
  onSaved,
  onClose,
}: {
  mode: "create" | "edit";
  familyId: string;
  transaction: FamilyTransactionRow | undefined;
  categories: Category[];
  onSaved: () => void;
  onClose: () => void;
}) {
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
    defaultValues: buildDefaultValues(mode, familyId, transaction),
  });

  const selectedType = useWatch({ control, name: "type" });
  const selectedCategoryId = useWatch({ control, name: "categoryId" });
  const categoriesForType = categories.filter((category) => category.type === selectedType);

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
        mode === "create"
          ? await createTransaction(values)
          : await updateTransaction(transaction!.id, values);

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

      onSaved();
      onClose();
    } catch {
      setFormError("Bir şeyler ters gitti. Lütfen tekrar deneyin.");
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === "create" ? "Yeni işlem" : "İşlemi düzenle"}</DialogTitle>
        <DialogDescription>
          {mode === "create"
            ? "Ailene bir gelir veya gider kaydı ekle."
            : "İşlem bilgilerini güncelle."}
        </DialogDescription>
      </DialogHeader>

      <form
        id="family-transaction-form"
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
              <Label id="family-transaction-type-label">Tür</Label>
              <div
                role="radiogroup"
                aria-labelledby="family-transaction-type-label"
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
                  Gelir
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
                  Gider
                </button>
              </div>
              <FieldError message={errors.type?.message} />
            </div>
          )}
        />

        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="family-amount">Tutar</Label>
            <Input
              id="family-amount"
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
                <Label htmlFor="family-currency">Para birimi</Label>
                <Select value={field.value} onValueChange={field.onChange} name={field.name}>
                  <SelectTrigger id="family-currency" className="w-18" aria-invalid={!!errors.currency}>
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
              <Label htmlFor="family-categoryId">Kategori</Label>
              <Select
                value={field.value || null}
                onValueChange={(value) => field.onChange(value ?? "")}
                name={field.name}
              >
                <SelectTrigger id="family-categoryId" className="w-full" aria-invalid={!!errors.categoryId}>
                  <SelectValue placeholder="Kategori seç">
                    {(value: string | null) =>
                      (value && categoriesForType.find((c) => c.id === value)?.name) ||
                      "Kategori seç"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {categoriesForType.length === 0 ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">
                      Bu türde kategori yok.
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
          <Label htmlFor="family-date">Tarih</Label>
          <Input
            id="family-date"
            type="date"
            max={todayInputValue()}
            aria-invalid={!!errors.date}
            {...register("date")}
          />
          <FieldError message={errors.date?.message} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="family-description">Açıklama (opsiyonel)</Label>
          <Textarea
            id="family-description"
            rows={2}
            placeholder="Örn. Haftalık market alışverişi"
            aria-invalid={!!errors.description}
            {...register("description")}
          />
          <FieldError message={errors.description?.message} />
        </div>
      </form>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Vazgeç
        </Button>
        <Button type="submit" form="family-transaction-form" disabled={isSubmitting}>
          {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {mode === "create" ? "İşlemi ekle" : "Değişiklikleri kaydet"}
        </Button>
      </DialogFooter>
    </>
  );
}
