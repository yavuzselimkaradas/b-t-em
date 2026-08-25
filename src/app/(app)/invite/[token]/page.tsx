import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, MailPlus } from "lucide-react";

import { AcceptInviteButton } from "@/components/family/accept-invite-button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const metadata: Metadata = { title: "Aile Daveti" };

/**
 * The confirm-before-joining screen for a shared invite link
 * (`/invite/${token}`, minted by `createInvite` — see
 * `components/family/invite-manager.tsx`). Deliberately does NOT call
 * `acceptInvite` here on the server: the task brief calls for an explicit
 * confirmation step before the join happens, so this page only renders the
 * token through to the client (`AcceptInviteButton`), which is the one that
 * actually calls `acceptInvite` — and only once the visitor clicks "Aileye
 * katıl".
 *
 * No family name is shown ahead of that click — `acceptInvite`'s contract
 * doesn't return one for an unaccepted token (by design: revealing which
 * family a bare token belongs to before proving membership would leak
 * information to anyone who merely guesses/intercepts a link), so the copy
 * here stays generic on purpose rather than pretending to preview it.
 *
 * Protected by src/proxy.ts (`/invite` is in `PROTECTED_PREFIXES`) — a
 * signed-out visitor is redirected to `/login?callbackUrl=/invite/<token>`
 * before this ever renders, so no session check is needed here; `token`
 * itself is still just an opaque string until `acceptInvite` validates and
 * looks it up server-side.
 */
export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Panele dön
        </Link>
      </div>

      <Card>
        <CardHeader>
          <span className="flex size-10 items-center justify-center rounded-full bg-brand-soft text-brand-soft-foreground">
            <MailPlus className="size-5" strokeWidth={2.25} />
          </span>
          <CardTitle className="mt-2">Bir aile davetin var</CardTitle>
          <CardDescription>
            Bu bağlantıyla bir aile bütçe planına katılacaksın. Katılınca diğer üyelerle ortak
            gelir ve giderleri görebilir, ekleyebilirsin.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AcceptInviteButton token={token} />
        </CardContent>
      </Card>
    </div>
  );
}
