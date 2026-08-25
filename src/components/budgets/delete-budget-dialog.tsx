"use client";

import { useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";

import { deleteBudget } from "@/lib/server/actions/budgets";
import { useScopedTranslations } from "@/lib/client/use-scoped-translations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormAlert } from "@/components/auth/form-elements";

interface DeleteBudgetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  budgetId: string;
  categoryName: string;
  /** `true` for `/budgets` (individual scope, tracks the active locale),
   * `false` for `/family/budgets` (stays pinned to Turkish) — see
   * `useScopedTranslations`'s doc comment. */
  isIndividual: boolean;
  onDeleted: (budgetId: string) => void;
}

/**
 * Same confirm/cancel shell and discipline as
 * transactions/delete-transaction-dialog.tsx — a fresh component rather
 * than a reuse of that one, since its copy is transaction-specific
 * ("İşlemi sil", "kayıt listenizden kaldırılır") and a Budget delete is a
 * real hard delete (no soft-delete undo — see `deleteBudget`'s doc
 * comment), which the wording below says explicitly.
 */
export function DeleteBudgetDialog({
  open,
  onOpenChange,
  budgetId,
  categoryName,
  isIndividual,
  onDeleted,
}: DeleteBudgetDialogProps) {
  const t = useScopedTranslations("budgets.deleteDialog", isIndividual);
  const tCommon = useScopedTranslations("common", isIndividual);
  const [error, setError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleConfirm = async () => {
    setError(null);
    setIsDeleting(true);
    try {
      const result = await deleteBudget(budgetId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      onDeleted(budgetId);
      onOpenChange(false);
    } catch {
      setError(tCommon("somethingWrong"));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isDeleting) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <div className="flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlert className="size-4.5" strokeWidth={2.25} />
          </div>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t.rich("description", {
              category: categoryName,
              b: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
            })}
          </DialogDescription>
        </DialogHeader>

        <FormAlert message={error} />

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
