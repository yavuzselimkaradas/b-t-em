"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { acceptInvite } from "@/lib/server/actions/family";
import { FormAlert } from "@/components/auth/form-elements";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Pulls a bare invite token out of either a full pasted invite URL
 * (".../invite/<token>") or a bare token pasted on its own — the user isn't
 * expected to know which of the two they were handed. Falls back to the
 * trimmed input verbatim when it isn't a parseable URL — `invite-manager.tsx`
 * only ever hands out a full link today, not a bare token, but this stays
 * lenient in case a user manually strips the URL down to just the token
 * before pasting it. Real validation/authorization still happens
 * server-side in `acceptInvite` (lib/server/actions/family.ts) — this is
 * best-effort extraction, not a trust boundary.
 */
function extractInviteToken(rawInput: string): string {
  const trimmed = rawInput.trim();
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split("/").filter(Boolean);
    const inviteIndex = segments.indexOf("invite");
    if (inviteIndex !== -1 && segments[inviteIndex + 1]) {
      return segments[inviteIndex + 1];
    }
  } catch {
    // Not a URL — assume the user pasted the bare token as-is.
  }
  return trimmed;
}

/**
 * The "Aile Planına Katıl" panel (see `family-onboarding-choice.tsx`) —
 * paste an invite link (or bare token), submit, done. Deliberately simpler
 * than `create-family-form.tsx` (react-hook-form + Zod): there's one field
 * and its only client-side "validation" is non-empty; the real acceptance
 * rules (expired / already used / already in a family) are enforced and
 * messaged by `acceptInvite` itself. This calls the exact same action as
 * `accept-invite-button.tsx` (the `/invite/[token]` landing page) — just
 * entered by pasting a link here instead of clicking one there, for a link
 * shared as plain text rather than opened directly.
 */
export function JoinFamilyForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = extractInviteToken(value);
    if (!token) {
      setError("Bir davet linki ya da kodu girin.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const result = await acceptInvite(token);
      if (!result.success) {
        setError(result.error);
        return;
      }
      // Already on /family — a refresh re-runs getMyFamily() server-side and
      // swaps this whole choice UI out for the real member view, same
      // "no client-side family state to manage" pattern as
      // create-family-form.tsx.
      router.refresh();
    } catch {
      setError("Bir şeyler ters gitti. Lütfen tekrar deneyin.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <FormAlert message={error} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="invite-link">Davet linki</Label>
        <Input
          id="invite-link"
          type="text"
          autoComplete="off"
          placeholder="https://.../invite/... ya da davet kodu"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          aria-invalid={!!error}
        />
      </div>

      <Button
        type="submit"
        size="lg"
        disabled={isSubmitting || !value.trim()}
        className="self-start"
      >
        {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
        Katıl
      </Button>
    </form>
  );
}
