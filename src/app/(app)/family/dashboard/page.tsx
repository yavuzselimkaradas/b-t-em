import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { auth } from "@/lib/server/auth";
import { getMyFamily } from "@/lib/server/actions/family";
import { PlanSwitcher } from "@/components/app/plan-switcher";
import { FamilyDashboard } from "@/components/family/family-dashboard";
import { LeaveFamilyButton } from "@/components/family/leave-family-button";

export const metadata: Metadata = { title: "Aile İşlemleri" };

/**
 * Aşama 3.5 — "Ortak/Aile Dashboard". Server Component: resolves which
 * family the signed-in user belongs to (`getMyFamily`) and hands its id off
 * to the Client Component that owns the rest of the page. No family yet (or
 * the lookup failed) → back to `/family`, which already owns the
 * create-family / error UI for both of those cases — this page has nothing
 * useful to render without a `familyId`.
 *
 * Protected by src/proxy.ts's `"/family"` prefix (a family plan inherently
 * requires an account, same as `/family` itself — see CLAUDE.md "Misafir
 * modu"), so `session.user.id` is safe to read without a guest-mode branch.
 */
export default async function FamilyDashboardPage() {
  const [session, result] = await Promise.all([auth(), getMyFamily()]);

  if (!result.success || !result.data) {
    redirect("/family");
  }

  const currentUserId = session?.user?.id;
  const isOwner = result.data.ownerId === currentUserId;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            href="/family"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Aile yönetimine dön
          </Link>
          <h1 className="font-display mt-2 text-3xl font-semibold tracking-tight text-foreground">
            {result.data.name}
          </h1>
          <p className="mt-1.5 text-muted-foreground">
            Ailenin ortak gelir ve giderlerini görüntüle, kendi işlemini ekle.
          </p>
        </div>

        {/* Same switcher as /transactions and /family — see plan-switcher.tsx. */}
        <PlanSwitcher active="family" />
      </div>

      <FamilyDashboard
        familyId={result.data.id}
        isOwner={isOwner}
        membersCanDeleteOwnTransactions={result.data.membersCanDeleteOwnTransactions}
        forceShareIndividualTransactions={result.data.forceShareIndividualTransactions}
        currentUserId={currentUserId}
      />

      <LeaveFamilyButton isOwner={isOwner} hasOtherMembers={result.data.members.length > 1} />
    </div>
  );
}
