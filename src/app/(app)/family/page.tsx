import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, LayoutDashboard } from "lucide-react";

import { auth } from "@/lib/server/auth";
import { getMyFamily, listActiveInvites, type ListInvitesResult } from "@/lib/server/actions/family";
import { PlanSwitcher } from "@/components/app/plan-switcher";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { FamilyOnboardingChoice } from "@/components/family/family-onboarding-choice";
import { InviteManager } from "@/components/family/invite-manager";
import { LeaveFamilyButton } from "@/components/family/leave-family-button";
import { MemberList } from "@/components/family/member-list";

export const metadata: Metadata = { title: "Aile Planı" };

// No `timeZone: "UTC"` override here (unlike transactions-view.tsx's
// `dateFormatter`) — that override exists specifically for the date-only
// "yyyy-mm-dd" transaction date, which is deliberately parsed/stored as UTC
// midnight to dodge timezone drift. `Family.createdAt` is a real timestamp
// (DB `now()`), so formatting it in whatever timezone this renders in is
// correct as-is.
const createdAtFormatter = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

/**
 * Aşama 3.1 — "Aile Oluşturma": renders one of three states depending on
 * `getMyFamily()`'s result. No client-side "yükleniyor" state to design for
 * — this Server Component awaits the data itself, so Next.js's normal
 * navigation/streaming boundary covers that; no other route in this app
 * (dashboard, transactions) adds its own `loading.tsx` either, so this
 * doesn't introduce a one-off pattern.
 *
 * Protected by src/proxy.ts (a family plan inherently requires an account —
 * see CLAUDE.md "Misafir modu"), so no guest-mode branching is needed here
 * the way transactions/page.tsx has, and `session.user.id` below is safe to
 * read without an extra null-check on the redirect path (still guarded
 * defensively since `auth()`'s return type itself is nullable).
 */
export default async function FamilyPage() {
  const [session, result] = await Promise.all([auth(), getMyFamily()]);
  const currentUserId = session?.user?.id;

  // `Family.ownerId` (not a scan over `members` for a `role === "OWNER"`
  // row) is the authoritative "am I the owner" check — `getMyFamily`
  // guarantees they always agree, and comparing the single scalar field is
  // simpler than re-deriving the same fact from the member list.
  const isOwner =
    result.success && result.data ? result.data.ownerId === currentUserId : false;

  // Only fetched for an owner — `listActiveInvites` itself would just
  // reject a non-owner with `NOT_OWNER_MESSAGE`, so there's nothing useful
  // to render from it for anyone else.
  const invitesResult = isOwner ? await listActiveInvites() : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
            {result.success && result.data ? result.data.name : "Aile Planı"}
          </h1>
          {result.success && result.data ? (
            <p className="mt-1.5 text-muted-foreground">
              {result.data.members.length} üye · {createdAtFormatter.format(result.data.createdAt)}{" "}
              tarihinde oluşturuldu
            </p>
          ) : null}
        </div>

        {/* Always shown (same as transactions-view.tsx) so switching between
            the individual and family plan reads as a tab change, not a
            navigation to an unrelated page — replaces the old standalone
            "İşlemlere dön" back-link, which did the same job less directly. */}
        <div className="flex items-center gap-3">
          <PlanSwitcher active="family" />
          {/* Aşama 3.5 — only rendered once a family actually exists (an
              empty/error state has nothing to view a dashboard for). Visible
              to owner and member alike, same as the dashboard itself. */}
          {result.success && result.data ? (
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link href="/family/dashboard">
                  <LayoutDashboard className="size-4" />
                  Aile işlemlerini görüntüle
                </Link>
              }
            />
          ) : null}
        </div>
      </div>

      {!result.success ? (
        <ErrorState message={result.error} />
      ) : result.data === null ? (
        <FamilyOnboardingChoice />
      ) : (
        <>
          <MemberList
            members={result.data.members}
            currentUserId={currentUserId}
            isOwner={isOwner}
          />
          {isOwner ? <InviteSection invitesResult={invitesResult} /> : null}
          <LeaveFamilyButton isOwner={isOwner} hasOtherMembers={result.data.members.length > 1} />
        </>
      )}
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <Card className="border-2 border-dashed border-destructive/30 bg-transparent shadow-none ring-0">
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertCircle className="size-6" strokeWidth={2} />
        </span>
        <div>
          <p className="font-medium text-foreground">Aile bilgileri yüklenemedi</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{message}</p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/family">Tekrar dene</Link>} />
      </CardContent>
    </Card>
  );
}

/**
 * Owner-only section (gated by `isOwner` at the call site) wrapping
 * `InviteManager` — the interactive part (create/copy/revoke) lives in that
 * Client Component; this stays a plain server-rendered `Card` shell so the
 * copy/heading match every other section on this page.
 */
function InviteSection({ invitesResult }: { invitesResult: ListInvitesResult | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Üye davet et</CardTitle>
        <CardDescription>
          Bir davet bağlantısı oluştur ve ailene katılmasını istediğin kişiyle paylaş.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <InviteManager
          invites={invitesResult?.success ? invitesResult.data : []}
          listError={invitesResult && !invitesResult.success ? invitesResult.error : null}
        />
      </CardContent>
    </Card>
  );
}
