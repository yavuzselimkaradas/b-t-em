"use client";

import { useState } from "react";
import { CheckCircle2, Mail, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { isMessageKey } from "@/lib/message-key";
import { resendVerificationEmail } from "@/lib/server/actions/email-verification";

type ResendState = { status: "idle" } | { status: "sending" } | { status: "sent" } | { status: "error"; message: string };

/**
 * Non-blocking reminder shown in the app shell (see `(app)/layout.tsx`)
 * when the signed-in user's email isn't verified yet — approved product
 * decision: an unverified account keeps FULL access to the app (consistent
 * with how permissive guest mode already is, CLAUDE.md "Misafir modu"),
 * this is a nudge, not a gate. Dismissible for the current browser session
 * (plain component state, not persisted) — reappears on the next full page
 * load/new session, since the underlying condition (still unverified)
 * hasn't changed; it isn't meant to be permanently silenced short of
 * actually verifying.
 */
export function EmailVerificationBanner() {
  const t = useTranslations("app.emailVerificationBanner");
  const [dismissed, setDismissed] = useState(false);
  const [resend, setResend] = useState<ResendState>({ status: "idle" });

  if (dismissed) return null;

  const handleResend = async () => {
    setResend({ status: "sending" });
    try {
      const result = await resendVerificationEmail();
      if (!result.success) {
        setResend({ status: "error", message: result.error });
        return;
      }
      setResend({ status: "sent" });
    } catch {
      setResend({ status: "error", message: "errors.validationFailed" });
    }
  };

  return (
    <div
      role="status"
      className="border-b border-border bg-brand-soft/60 px-4 py-2.5 text-sm text-brand-soft-foreground sm:px-6"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-1.5">
        <Mail className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">{t("message")}</span>

        {resend.status === "sent" ? (
          <span className="flex items-center gap-1 text-xs font-medium">
            <CheckCircle2 className="size-3.5" aria-hidden />
            {t("resendSuccess")}
          </span>
        ) : (
          <button
            type="button"
            onClick={handleResend}
            disabled={resend.status === "sending"}
            className={cn(
              "text-xs font-medium underline underline-offset-2 hover:no-underline",
              resend.status === "sending" && "opacity-60"
            )}
          >
            {resend.status === "sending" ? t("resending") : t("resend")}
          </button>
        )}

        {resend.status === "error" ? (
          <span className="w-full text-xs text-destructive">
            {isMessageKey(resend.message) ? <ResendErrorText messageKey={resend.message} /> : resend.message}
          </span>
        ) : null}

        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label={t("dismiss")}
          className="ml-auto shrink-0 rounded-sm p-0.5 text-brand-soft-foreground/70 transition-colors hover:text-brand-soft-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Small helper so the resend-error message can go through `useTranslations`
 * without making the whole banner re-render around a conditional hook call
 * (hooks can't be called conditionally in the parent). */
function ResendErrorText({ messageKey }: { messageKey: string }) {
  const t = useTranslations();
  return <>{t(messageKey)}</>;
}
