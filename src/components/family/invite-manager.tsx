"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Link2, Loader2, X } from "lucide-react";

import {
  createInvite,
  revokeInvite,
  type CreateInviteData,
  type FamilyInviteSummary,
} from "@/lib/server/actions/family";
import { FormAlert } from "@/components/auth/form-elements";
import { Button } from "@/components/ui/button";

const expiryFormatter = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

/**
 * `invites` is deliberately used straight from props on every render, never
 * copied into local `useState` — after `handleCreate`/`handleRevoke` call
 * `router.refresh()`, the parent Server Component (`family/page.tsx`)
 * re-runs `listActiveInvites()` and this Client Component receives the
 * fresh array as a new prop value, which React just re-renders with. Same
 * "let the server own the data, refresh to re-sync" shape as
 * `create-family-form.tsx`, applied to a list instead of a full subtree
 * swap.
 *
 * DELIBERATE DEVIATION from a literal read of the frontend task brief: the
 * brief asked for a "copy link" action on every row of the active-invites
 * list, but `listActiveInvites` (lib/server/actions/family.ts) intentionally
 * never returns a `token` for already-created invites — re-exposing a
 * bearer credential in a list view was called out there as a needless leak
 * surface. So "copy" only exists for the invite just minted by this
 * component (`justCreated`, which DOES carry a raw token, exactly once).
 * Older rows only get an expiry readout + "İptal et" — flagged here for
 * whoever picks this up next rather than silently working around the
 * backend contract.
 */
export function InviteManager({
  invites,
  listError,
}: {
  invites: FamilyInviteSummary[];
  listError: string | null;
}) {
  const router = useRouter();

  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<CreateInviteData | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  async function copyLink(token: string, key: string) {
    const shareUrl = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 2000);
    } catch {
      // Clipboard permission denied or unsupported (e.g. insecure context)
      // — the link text is still visible on screen for a manual copy, so
      // this fails silently rather than showing an alarming error for a
      // non-critical convenience action.
    }
  }

  async function handleCreate() {
    setIsCreating(true);
    setCreateError(null);
    try {
      const result = await createInvite();
      if (!result.success) {
        setCreateError(result.error);
        return;
      }
      setJustCreated(result.data);
      router.refresh();
    } catch {
      setCreateError("Bir şeyler ters gitti. Lütfen tekrar deneyin.");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleRevoke(inviteId: string) {
    setRevokingId(inviteId);
    setRevokeError(null);
    try {
      const result = await revokeInvite(inviteId);
      if (!result.success) {
        setRevokeError(result.error);
        return;
      }
      router.refresh();
    } catch {
      setRevokeError("Bir şeyler ters gitti. Lütfen tekrar deneyin.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <FormAlert message={listError} />

      <div className="flex flex-col gap-3">
        <FormAlert message={createError} />

        <Button
          type="button"
          onClick={handleCreate}
          disabled={isCreating}
          className="self-start"
        >
          {isCreating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Link2 className="size-4" />
          )}
          Davet linki oluştur
        </Button>

        {justCreated ? (
          <div className="flex flex-col gap-2 rounded-lg border border-brand/25 bg-brand-soft/40 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-brand-soft-foreground">
                  Davet bağlantın hazır
                </p>
                <p className="mt-0.5 text-xs text-brand-soft-foreground/80">
                  Bu bağlantıyı yalnızca şimdi görebilirsin, kopyalamayı unutma.{" "}
                  {expiryFormatter.format(justCreated.expiresAt)} tarihine kadar geçerli.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setJustCreated(null)}
                aria-label="Kapat"
                className="shrink-0 text-brand-soft-foreground/60 transition-colors hover:text-brand-soft-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground">
                {/* `justCreated` is only ever set inside `handleCreate`, a
                    client-triggered event handler that runs after
                    hydration — `window` is always defined by the time this
                    branch renders, so no SSR/hydration-mismatch guard is
                    needed here. */}
                {`${window.location.origin}/invite/${justCreated.token}`}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => copyLink(justCreated.token, "new")}
              >
                {copiedKey === "new" ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copiedKey === "new" ? "Kopyalandı" : "Kopyala"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Aktif davetler
        </p>
        <FormAlert message={revokeError} />
        {invites.length === 0 ? (
          <p className="text-sm text-muted-foreground">Henüz aktif bir davet bağlantın yok.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {invites.map((invite) => (
              <li
                key={invite.id}
                className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                <p className="text-sm text-muted-foreground">
                  {expiryFormatter.format(invite.expiresAt)} tarihine kadar geçerli
                </p>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={revokingId === invite.id}
                  onClick={() => handleRevoke(invite.id)}
                >
                  {revokingId === invite.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <X className="size-3.5" />
                  )}
                  İptal et
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
