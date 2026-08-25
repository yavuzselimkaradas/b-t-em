import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Info } from "lucide-react";

import { auth } from "@/lib/server/auth";
import { getMyFamily } from "@/lib/server/actions/family";
import { BudgetList } from "@/components/budgets/budget-list";
import { ShareTransactionsToggle } from "@/components/family/share-transactions-toggle";
import { ForceShareToggle } from "@/components/family/force-share-toggle";
import { MembersCanDeleteOwnTransactionsToggle } from "@/components/family/members-can-delete-toggle";

export const metadata: Metadata = { title: "Aile Bütçe Limitleri" };

/**
 * Same Server Component → familyId/`isOwner` resolution pattern as
 * family/dashboard/page.tsx: no family yet (or the lookup failed) → back to
 * `/family`, which already owns the create-family / error UI for both
 * cases. `isOwner` gates `BudgetList`'s `canManage` — a MEMBER may still
 * view every limit (`listBudgets` allows any member), just not
 * create/edit/delete one (`createBudget`/`updateBudget`/`deleteBudget` are
 * OWNER-only for a family scope — see budgets.ts's doc comments). The
 * banner below explains *why* the add/edit controls are absent for a
 * member, rather than just silently hiding them.
 *
 * `ForceShareToggle` (owner-only family-wide kill switch) and
 * `MembersCanDeleteOwnTransactionsToggle` (owner-only "let members delete
 * their own real family transactions" switch) render right after
 * `ShareTransactionsToggle` (each member's own preference) — all three
 * live on this same "Aile Planı Ayarları" destination despite the page's
 * visible title being about budget limits. `ShareTransactionsToggle` gets
 * `isLockedByOwner={!isOwner && result.data.forceShareIndividualTransactions}`
 * so the lock only ever visually applies to a MEMBER's own render — the
 * owner's toggle is never locked by their own switch.
 *
 * Protected by src/proxy.ts's `"/family"` prefix, so `session.user.id` is
 * safe to read without a guest-mode branch.
 */
export default async function FamilyBudgetsPage() {
  const [session, result] = await Promise.all([auth(), getMyFamily()]);

  if (!result.success || !result.data) {
    redirect("/family");
  }

  const currentUserId = session?.user?.id;
  const isOwner = result.data.ownerId === currentUserId;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/family"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Aile yönetimine dön
        </Link>
        <h1 className="font-display mt-2 text-3xl font-semibold tracking-tight text-foreground">
          Aile Bütçe Limitleri
        </h1>
        <p className="mt-1.5 text-muted-foreground">
          Gider kategorilerindeki aylık limitleri görüntüle.
        </p>
      </div>

      <ShareTransactionsToggle
        initialValue={
          result.data.members.find((member) => member.userId === currentUserId)
            ?.shareIndividualTransactions ?? false
        }
        isLockedByOwner={!isOwner && result.data.forceShareIndividualTransactions}
      />

      {isOwner ? (
        <ForceShareToggle initialValue={result.data.forceShareIndividualTransactions} />
      ) : null}

      {isOwner ? (
        <MembersCanDeleteOwnTransactionsToggle
          initialValue={result.data.membersCanDeleteOwnTransactions}
        />
      ) : null}

      {!isOwner ? (
        <div
          role="note"
          className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground"
        >
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>
            Limitleri yalnızca ailenin sahibi ekleyip düzenleyebilir. Sen üye olarak limitleri
            görüntüleyebilirsin.
          </span>
        </div>
      ) : null}

      <BudgetList scope={{ familyId: result.data.id }} canManage={isOwner} />
    </div>
  );
}
