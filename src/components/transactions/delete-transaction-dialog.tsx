"use client";

import { useState, type ReactNode } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import type { TransactionDeleteResult } from "@/lib/client/transaction-view-model";
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

interface DeleteTransactionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transactionId: string;
  transactionLabel: string;
  /** Either `source.softDelete` from lib/client/transactions-source.ts (the
   * account or guest one — the caller already resolved which) — this
   * component never imports a Server Action or the guest store directly. */
  onDelete: (transactionId: string) => Promise<TransactionDeleteResult>;
  onDeleted: (transactionId: string) => void;
  /** Optional copy overrides — the individual `/transactions` page never
   * passes these and keeps the default "İşlemi sil" wording below. The
   * family dashboard passes distinct copy for its two delete modes ("Aile
   * hesabından kaldır" vs. "Kalıcı olarak sil") so the two actions read as
   * unmistakably different — see family-dashboard.tsx. */
  title?: string;
  description?: ReactNode;
  confirmLabel?: string;
}

/**
 * Confirms before soft-deleting a transaction. The delete itself has no
 * data-loss risk (both backends soft-delete — see `softDeleteTransaction` /
 * `softDeleteGuestTransaction`), but the confirmation step still matters for
 * UX: it's the only guard against an accidental click on a row someone
 * didn't mean to remove.
 */
export function DeleteTransactionDialog({
  open,
  onOpenChange,
  transactionId,
  transactionLabel,
  onDelete,
  onDeleted,
  title,
  description,
  confirmLabel,
}: DeleteTransactionDialogProps) {
  const t = useTranslations("transactions.deleteDialog");
  const tCommon = useTranslations("common");
  const [error, setError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleConfirm = async () => {
    setError(null);
    setIsDeleting(true);
    try {
      const result = await onDelete(transactionId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      onDeleted(transactionId);
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
          <DialogTitle>{title ?? t("title")}</DialogTitle>
          <DialogDescription>
            {description ?? t.rich("description", {
              label: transactionLabel,
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
            {confirmLabel ?? t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
