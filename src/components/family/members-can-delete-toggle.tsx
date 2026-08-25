"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { updateMembersCanDeleteOwnTransactions } from "@/lib/server/actions/family";
import { FormAlert } from "@/components/auth/form-elements";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

interface MembersCanDeleteOwnTransactionsToggleProps {
  /** `FamilyData.membersCanDeleteOwnTransactions` from `getMyFamily()` —
   * the family-wide switch value, not any one member's own permission. */
  initialValue: boolean;
}

/**
 * Owner-only toggle on `/family/budgets` (the "Aile Planı Ayarları"
 * destination) that lets a MEMBER delete REAL aile işlemleri (`familyId`
 * set) THEY THEMSELVES created — only ever rendered when `isOwner` is true;
 * the page decides that gating, this component assumes it. Same optimistic
 * update + `Switch` + `FormAlert` shape as `ForceShareToggle`, wired to
 * `updateMembersCanDeleteOwnTransactions` (lib/server/actions/family.ts)
 * instead.
 *
 * This does NOT change the owner's own delete rights (owner could already
 * delete any family transaction) and never lets a member delete another
 * member's or the owner's transaction — only their own. Enforcement lives
 * server-side in `assertCanDeleteTransaction`
 * (lib/server/actions/transactions.ts); this toggle only shows/hides the
 * "Sil" control, it is not itself the security boundary (CLAUDE.md).
 */
export function MembersCanDeleteOwnTransactionsToggle({
  initialValue,
}: MembersCanDeleteOwnTransactionsToggleProps) {
  const router = useRouter();
  const [checked, setChecked] = useState(initialValue);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(next: boolean) {
    const previous = checked;
    setChecked(next); // optimistic — snappier than waiting on a round-trip for a plain toggle
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await updateMembersCanDeleteOwnTransactions(next);
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
        <CardTitle>Üyelerin kendi işlemlerini silmesine izin ver</CardTitle>
        <CardDescription>
          Açık olduğunda, ailedeki üyeler yalnızca KENDİ oluşturdukları aile işlemlerini
          silebilir — başka bir üyenin ya da senin (sahibin) eklediği işlemlere dokunamazlar.
          Düzenleme yetkisi bundan etkilenmez, zaten herkes yalnızca kendi işlemini
          düzenleyebiliyordu. Kapalı olduğunda (varsayılan), üyeler hiçbir aile işlemini
          silemez — silme yetkisi yalnızca sende kalır. Bu ayar senin kendi silme yetkini
          etkilemez, sen her zaman tüm aile işlemlerini silebilirsin.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <FormAlert message={error} />
        <label className="flex w-fit items-center gap-3">
          <Switch
            checked={checked}
            onCheckedChange={handleChange}
            disabled={isSubmitting}
            aria-label="Üyelerin kendi işlemlerini silmesine izin ver"
          />
          <span className="text-sm font-medium text-foreground">
            {checked ? "Açık" : "Kapalı"}
          </span>
          {isSubmitting ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        </label>
      </CardContent>
    </Card>
  );
}
