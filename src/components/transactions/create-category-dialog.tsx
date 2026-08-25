"use client";

import { useState, type FormEvent } from "react";
import type { Category } from "@prisma/client";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CategoryFieldErrors, CreateCategoryResult } from "@/lib/client/transaction-view-model";
import { useScopedTranslations } from "@/lib/client/use-scoped-translations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormAlert, FieldError } from "@/components/auth/form-elements";

interface CreateCategoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Either `source.createCategory` from lib/client/transactions-source.ts
   * (the account or guest one — the caller already resolved which) — this
   * component never imports a Server Action or the guest store directly,
   * same pattern as `DeleteTransactionDialog`'s `onDelete`. */
  onCreate: (input: unknown) => Promise<CreateCategoryResult>;
  onCreated: (category: Category) => void;
  /** Pre-fills the type toggle with whatever the filter bar's own "Tür"
   * selection currently is — if the user is filtering by "Gider" and clicks
   * "Yeni kategori ekle" from that context, defaulting to Gider saves a
   * click. Falls back to "EXPENSE" when the ambient filter is "Tümü". */
  defaultType?: "INCOME" | "EXPENSE";
  /** `true` on `/transactions` (tracks the active locale), omitted/`false`
   * on `/family/dashboard` (stays pinned to Turkish) — see
   * lib/client/use-scoped-translations.ts's doc comment. */
  translate?: boolean;
}

/**
 * Small form for creating a personal category — reached from the filter
 * bar's Kategori dropdown ("+ Yeni kategori ekle"). Deliberately just name
 * + type: icon/color aren't user-set anywhere in this app yet
 * (`category-visual.ts` derives a deterministic look from the id), so
 * asking for them here would be a form field nobody else can act on.
 */
export function CreateCategoryDialog({
  open,
  onOpenChange,
  onCreate,
  onCreated,
  defaultType = "EXPENSE",
  translate = false,
}: CreateCategoryDialogProps) {
  const t = useScopedTranslations("transactions.categoryDialog", translate);
  const tFilters = useScopedTranslations("transactions.filters", translate);
  const tCommon = useScopedTranslations("common", translate);
  const [name, setName] = useState("");
  const [type, setType] = useState<"INCOME" | "EXPENSE">(defaultType);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<CategoryFieldErrors>({});
  const [isSaving, setIsSaving] = useState(false);

  const reset = () => {
    setName("");
    setType(defaultType);
    setError(null);
    setFieldErrors({});
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setIsSaving(true);
    try {
      const result = await onCreate({ name, type });
      if (!result.success) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      onCreated(result.data);
      onOpenChange(false);
      reset();
    } catch {
      setError(tCommon("somethingWrong"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isSaving) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FormAlert message={error} />

          <div className="flex flex-col gap-1.5">
            <Label id="new-category-type-label" className="text-xs text-muted-foreground">
              {t("typeLabel")}
            </Label>
            <div
              role="radiogroup"
              aria-labelledby="new-category-type-label"
              className="inline-flex w-fit rounded-lg bg-muted p-0.5"
            >
              {(["INCOME", "EXPENSE"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={type === option}
                  onClick={() => setType(option)}
                  className={cn(
                    "rounded-[7px] px-3 py-1 text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                    type === option
                      ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {option === "INCOME" ? tFilters("income") : tFilters("expense")}
                </button>
              ))}
            </div>
            <FieldError message={fieldErrors.type?.[0]} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-category-name">{t("nameLabel")}</Label>
            <Input
              id="new-category-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("namePlaceholder")}
              maxLength={50}
              autoFocus
              aria-invalid={!!fieldErrors.name}
            />
            <FieldError message={fieldErrors.name?.[0]} />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={isSaving || name.trim().length === 0}>
              {isSaving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
