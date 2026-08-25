"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Loader2 } from "lucide-react";

import { updateTransactionSharing } from "@/lib/server/actions/family";
import { FormAlert } from "@/components/auth/form-elements";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

interface ShareTransactionsToggleProps {
  /** The signed-in member's own current preference — `getMyFamily()`'s
   * member list already carries this, no separate fetch needed. */
  initialValue: boolean;
  /** `FamilyData.forceShareIndividualTransactions`, but only as it applies
   * to THIS caller: the page always passes `false` for the owner (the lock
   * never applies to their own toggle — see `ForceShareToggle`'s doc
   * comment) and the real family-wide value for a member. When `true`, this
   * member's toggle is forced on and can no longer be changed — mirrors the
   * server's own rejection in `updateTransactionSharing`, so the UI never
   * offers a control the backend would refuse anyway. */
  isLockedByOwner: boolean;
}

/**
 * "Bireysel işlemlerimi ailemle paylaş" toggle on `/family/budgets` (the
 * "Aile Planı Ayarları" destination) — each member controls only their OWN
 * preference (`updateTransactionSharing`, lib/server/actions/family.ts), so
 * this renders for owner and member alike, no `canManage` gating unlike
 * `BudgetList` on the same page.
 *
 * Turning this on does NOT move or duplicate any transaction — it only
 * widens what the family's shared views (`family-transactions.ts`) include
 * for THIS member's individual (bireysel) transactions, read-only. Editing/
 * deleting them always stays exclusively with their owner, exactly as
 * before — see the toggle's own description text below, kept honest rather
 * than implying anything is "moved" to the family.
 *
 * `isLockedByOwner` reflects the OWNER's separate family-wide kill switch
 * (`ForceShareToggle` / `updateForceShareIndividualTransactions`): the page
 * always passes `false` for the owner's own render of this component, so
 * the lock only ever visually applies to a MEMBER — matching the server,
 * which exempts the owner from their own lock too.
 */
export function ShareTransactionsToggle({
  initialValue,
  isLockedByOwner,
}: ShareTransactionsToggleProps) {
  const router = useRouter();
  const [checked, setChecked] = useState(initialValue);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(next: boolean) {
    if (isLockedByOwner) return; // defensive — the Switch below is already disabled

    const previous = checked;
    setChecked(next); // optimistic — snappier than waiting on a round-trip for a plain toggle
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await updateTransactionSharing(next);
      if (!result.success) {
        setChecked(previous);
        setError(result.error);
        return;
      }
      router.refresh();
    } catch {
      setChecked(previous);
      setError("Bir şeyler ters gitti. Lütfen tekrar deneyin.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bireysel işlemlerimi ailemle paylaş</CardTitle>
        <CardDescription>
          Açık olduğu sürece, bireysel plana BUNDAN SONRA gireceğin gelir/gider kayıtları bu
          ailenin ortak görünümünde de (salt-okunur) görünür — işlemler sende kalır, düzenleme/
          silme yetkisi her zaman sende olmaya devam eder. Kapattığında sadece o andan sonra
          gireceğin kayıtlar paylaşılmaz — daha önce paylaşılmış olanlar geriye dönük gizlenmez;
          açtığında da daha önce (kapalıyken) girdiğin kayıtlar sonradan paylaşılmaz.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <FormAlert message={error} />
        <label className="flex w-fit items-center gap-3">
          <Switch
            checked={isLockedByOwner ? true : checked}
            onCheckedChange={handleChange}
            disabled={isSubmitting || isLockedByOwner}
            aria-label="Bireysel işlemlerimi ailemle paylaş"
          />
          <span className="text-sm font-medium text-foreground">
            {isLockedByOwner ? "Açık" : checked ? "Açık" : "Kapalı"}
          </span>
          {isSubmitting ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        </label>
        {isLockedByOwner ? (
          <div
            role="note"
            className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground"
          >
            <Lock className="mt-0.5 size-4 shrink-0" />
            <span>
              Ailenin sahibi bu özelliği tüm üyeler için zorunlu hale getirdi — kendi tercihini şu
              an değiştiremezsin.
            </span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
