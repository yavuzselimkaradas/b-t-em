"use client";

import { useState, type ComponentType } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, Clock, Loader2, Users } from "lucide-react";

import { acceptInvite } from "@/lib/server/actions/family";
import { Button } from "@/components/ui/button";

// Mirrors the exact Turkish strings `acceptInvite` (lib/server/actions/
// family.ts) can return, so a recognized failure gets a tailored icon/title/
// next-step instead of a bare red banner. Not exported constants on that
// file (they're private there), so this list is duplicated by value — if
// wording drifts, the worst case is falling through to the generic
// `ResultState` below, which still shows the real `result.error` text, just
// without the tailored icon/CTA.
const ALREADY_IN_FAMILY_MESSAGE = "Zaten bir aile planındasınız.";
const EXPIRED_MESSAGE = "Bu davetin süresi dolmuş.";

/**
 * The confirm → accept flow for `/invite/[token]`. Renders the "Aileye
 * katıl" call-to-action until `acceptInvite` resolves: success redirects to
 * `/family` (which re-fetches the now-updated membership itself, so no
 * client-side family state needs to travel along); failure swaps the CTA
 * out for a `ResultState` — a known rejection reason (already in a family,
 * link expired) gets a tailored message and next step, anything else
 * (not found / already used / a thrown error) gets a generic one.
 */
export function AcceptInviteButton({ token }: { token: string }) {
  const router = useRouter();
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAccept() {
    setIsAccepting(true);
    setError(null);
    try {
      const result = await acceptInvite(token);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.push("/family");
      router.refresh();
    } catch {
      setError("Bir şeyler ters gitti. Lütfen tekrar deneyin.");
    } finally {
      setIsAccepting(false);
    }
  }

  if (error === ALREADY_IN_FAMILY_MESSAGE) {
    return (
      <ResultState
        icon={Users}
        tone="brand"
        title="Zaten bir aile planındasın"
        message="Yeni bir davet kabul etmeden önce mevcut aile planından ayrılman gerekiyor."
        actionHref="/family"
        actionLabel="Aile planına git"
      />
    );
  }

  if (error === EXPIRED_MESSAGE) {
    return (
      <ResultState
        icon={Clock}
        tone="muted"
        title="Bu davetin süresi dolmuş"
        message="Davet bağlantılarının geçerlilik süresi sınırlıdır. Aileden yeni bir davet linki istemen gerekiyor."
        actionHref="/dashboard"
        actionLabel="Panele dön"
      />
    );
  }

  if (error) {
    return (
      <ResultState
        icon={AlertCircle}
        tone="destructive"
        title="Bu davet kullanılamıyor"
        message={error}
        actionHref="/dashboard"
        actionLabel="Panele dön"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="lg" onClick={handleAccept} disabled={isAccepting}>
          {isAccepting ? <Loader2 className="size-4 animate-spin" /> : null}
          Aileye katıl
        </Button>
        <Button
          variant="outline"
          size="lg"
          nativeButton={false}
          render={<Link href="/dashboard">Vazgeç</Link>}
        />
      </div>
    </div>
  );
}

function ResultState({
  icon: Icon,
  tone,
  title,
  message,
  actionHref,
  actionLabel,
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  tone: "brand" | "muted" | "destructive";
  title: string;
  message: string;
  actionHref: string;
  actionLabel: string;
}) {
  const toneClasses =
    tone === "brand"
      ? "bg-brand-soft text-brand-soft-foreground"
      : tone === "destructive"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";

  return (
    <div className="flex flex-col items-start gap-3">
      <span className={`flex size-10 items-center justify-center rounded-full ${toneClasses}`}>
        <Icon className="size-5" strokeWidth={2.25} />
      </span>
      <div>
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      <Button nativeButton={false} render={<Link href={actionHref}>{actionLabel}</Link>} />
    </div>
  );
}
