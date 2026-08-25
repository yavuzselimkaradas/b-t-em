"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogOut, TriangleAlert } from "lucide-react";

import { leaveFamily } from "@/lib/server/actions/family";
import { FormAlert } from "@/components/auth/form-elements";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface LeaveFamilyButtonProps {
  isOwner: boolean;
  /** Whether the family has any member besides the signed-in user — only
   * relevant when `isOwner` is true, to pick the right confirmation copy
   * (ownership transfers vs. the family gets disbanded). */
  hasOtherMembers: boolean;
}

/**
 * Standalone "Aileden çık" action at the bottom of `/family` — available to
 * `OWNER` and `MEMBER` alike. `leaveFamily` (lib/server/actions/family.ts)
 * now supports both: a member just leaves; an owner either hands ownership
 * to the next-longest-tenured remaining member, or (if they're the only one
 * left) disbands the family entirely — see that action's doc comment for
 * the full mechanics. This component only needs to know which confirmation
 * copy applies, not run any of that logic itself.
 *
 * Deliberately separate from `member-list.tsx`'s per-row actions (which are
 * about the OWNER acting on someone ELSE's row) rather than another inline
 * row for "leave" — this is the signed-in user's own, more consequential
 * choice about their OWN membership, so it gets one clear, explicit control
 * instead of a small link buried in a list row.
 */
export function LeaveFamilyButton({ isOwner, hasOtherMembers }: LeaveFamilyButtonProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function closeDialog() {
    if (isSubmitting) return;
    setIsOpen(false);
    setError(null);
  }

  async function handleConfirm() {
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await leaveFamily();
      if (!result.success) {
        setError(result.error);
        return;
      }
      setIsOpen(false);
      // The signed-in user's own membership is gone either way (transferred
      // ownership away, or the whole family was disbanded) — getMyFamily()
      // will now return `data: null`, which family/page.tsx renders as the
      // "start/join a family" onboarding choice.
      router.push("/family");
      router.refresh();
    } catch {
      setError("Bir şeyler ters gitti. Lütfen tekrar deneyin.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const description =
    isOwner && hasOtherMembers
      ? "Bu aile planından ayrılmak istediğinize emin misiniz? Sahiplik, aileye en uzun süredir üye olan kişiye otomatik olarak devredilecek."
      : isOwner
        ? "Bu aile planından ayrılmak istediğinize emin misiniz? Ailede başka üye olmadığı için aile planı tamamen kapatılacak."
        : "Bu aile planından ayrılmak istediğinize emin misiniz?";

  return (
    <>
      <div className="flex justify-center border-t border-border pt-6">
        <Button type="button" variant="destructive" size="lg" onClick={() => setIsOpen(true)}>
          <LogOut className="size-4" />
          Aileden çık
        </Button>
      </div>

      <Dialog
        open={isOpen}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <div className="flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlert className="size-4.5" strokeWidth={2.25} />
            </div>
            <DialogTitle>Aileden ayrıl</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <FormAlert message={error} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={isSubmitting}>
              Vazgeç
            </Button>
            <Button type="button" variant="destructive" onClick={handleConfirm} disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
              Evet, ayrıl
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
