"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Crown, Loader2, TriangleAlert, User as UserIcon, UserMinus } from "lucide-react";

import { cn } from "@/lib/utils";
import { removeMember, type FamilyMemberInfo } from "@/lib/server/actions/family";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormAlert } from "@/components/auth/form-elements";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const letters = parts.map((part) => part[0]?.toUpperCase()).join("");
  return letters || "?";
}

type PendingRemoval = { memberId: string; memberName: string } | null;

/**
 * Aşama 3.4 — "Üye Yönetimi". Owns the full member list UI (moved here from
 * `family/page.tsx`'s `MemberListCard` — same avatar/badge markup, just with
 * a per-row destructive action layered on top) plus its confirm dialog:
 *  - Owner, on any OTHER member's row: "Çıkar" → `removeMember(memberId)`.
 *
 * The signed-in user's own "leave the family" action does NOT live here
 * (moved to `leave-family-button.tsx`, a standalone control at the bottom of
 * `/family` — see that component's doc comment for why) even though it used
 * to be a per-row link here for a plain member. Owner and member alike now
 * leave through that one shared control instead of two different-looking
 * affordances.
 *
 * `removeMember` refreshes the server-owned data on success rather than
 * mutating local state, same "let the server own the data" pattern as
 * `invite-manager.tsx`.
 */
export function MemberList({
  members,
  currentUserId,
  isOwner,
}: {
  members: FamilyMemberInfo[];
  currentUserId: string | undefined;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingRemoval>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function closeDialog() {
    if (isSubmitting) return;
    setPending(null);
    setError(null);
  }

  async function handleConfirm() {
    if (!pending) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await removeMember(pending.memberId);
      if (!result.success) {
        setError(result.error);
        return;
      }
      setPending(null);
      router.refresh();
    } catch {
      setError("Bir şeyler ters gitti. Lütfen tekrar deneyin.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Üyeler</CardTitle>
          <CardDescription>Aile planındaki herkes.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y divide-border">
            {members.map((member) => {
              const memberIsOwner = member.role === "OWNER";
              const isCurrentUser = member.userId === currentUserId;
              return (
                <li
                  key={member.id}
                  className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Avatar>
                      <AvatarFallback>{initials(member.userName)}</AvatarFallback>
                    </Avatar>
                    <p className="min-w-0 truncate text-sm font-medium text-foreground">
                      {member.userName}
                      {isCurrentUser ? (
                        <span className="font-normal text-muted-foreground"> (Siz)</span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge
                      className={cn(
                        "gap-1 border-transparent",
                        memberIsOwner
                          ? "bg-brand-soft text-brand-soft-foreground"
                          : "bg-secondary text-secondary-foreground"
                      )}
                    >
                      {memberIsOwner ? (
                        <Crown className="size-3" strokeWidth={2.5} />
                      ) : (
                        <UserIcon className="size-3" strokeWidth={2.5} />
                      )}
                      {memberIsOwner ? "Sahip" : "Üye"}
                    </Badge>

                    {/* Owner can remove any OTHER member — never themselves
                        (backend rejects it; the whole self-row hides it
                        too, so there's nothing to click that could
                        surface that rejection). Removing oneself is
                        "Aileden çık" (leave-family-button.tsx) instead. */}
                    {isOwner && !isCurrentUser ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${member.userName} adlı üyeyi aileden çıkar`}
                        onClick={() =>
                          setPending({
                            memberId: member.id,
                            memberName: member.userName,
                          })
                        }
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <UserMinus className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Dialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <div className="flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlert className="size-4.5" strokeWidth={2.25} />
            </div>
            <DialogTitle>Üyeyi çıkar</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{pending?.memberName}</span> adlı üyeyi
              aileden çıkarmak istediğinize emin misiniz?
            </DialogDescription>
          </DialogHeader>

          <FormAlert message={error} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={isSubmitting}>
              Vazgeç
            </Button>
            <Button type="button" variant="destructive" onClick={handleConfirm} disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
              Evet, çıkar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
