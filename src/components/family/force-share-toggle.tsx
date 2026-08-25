"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { updateForceShareIndividualTransactions } from "@/lib/server/actions/family";
import { FormAlert } from "@/components/auth/form-elements";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

interface ForceShareToggleProps {
  /** `FamilyData.forceShareIndividualTransactions` from `getMyFamily()` —
   * the family-wide switch value, not any one member's own preference. */
  initialValue: boolean;
}

/**
 * Owner-only "diğer üyelere paylaşma tercihini yasakla ve bireysel
 * işlemlerini zorunlu paylaş" kill switch on `/family/budgets` (the "Aile
 * Planı Ayarları" destination) — only ever rendered when `isOwner` is true;
 * the page decides that gating, this component assumes it. Same optimistic
 * update + `Switch` + `FormAlert` shape as `ShareTransactionsToggle`, wired
 * to `updateForceShareIndividualTransactions` (lib/server/actions/family.ts)
 * instead of `updateTransactionSharing`.
 *
 * This does NOT touch the owner's own sharing preference — it only locks
 * every OTHER member's `shareIndividualTransactions` toggle and, while on,
 * widens the family's shared views to include every current member's
 * individual transactions regardless of their own toggle value (read-time
 * only, see the server action's doc comment). The owner keeps using their
 * own `ShareTransactionsToggle` exactly as before, rendered separately on
 * the same page.
 */
export function ForceShareToggle({ initialValue }: ForceShareToggleProps) {
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
      const result = await updateForceShareIndividualTransactions(next);
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
        <CardTitle>Ailedeki diğer üyelere bireysel işlem paylaşımını yasakla</CardTitle>
        <CardDescription>
          Açık olduğunda, ailedeki diğer üyeler kendi &quot;Bireysel işlemlerimi ailemle
          paylaş&quot; tercihlerini artık değiştiremez — herkesin TÜM bireysel gelir/gider
          kayıtları (kendi tercihleri ne olursa olsun) otomatik olarak aile ortak görünümünde
          (salt-okunur) görünür hale gelir. İşlemler yine de sahibinde kalır, düzenleme/silme
          yetkisi her zaman kaydı oluşturan kişide olmaya devam eder. Kapalı olduğunda (varsayılan)
          her üye kendi paylaşım tercihini eskisi gibi serbestçe kontrol eder. Bu ayar senin kendi
          paylaşım tercihini etkilemez, sadece diğer üyeleri kapsar.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <FormAlert message={error} />
        <label className="flex w-fit items-center gap-3">
          <Switch
            checked={checked}
            onCheckedChange={handleChange}
            disabled={isSubmitting}
            aria-label="Ailedeki diğer üyelere bireysel işlem paylaşımını yasakla"
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
