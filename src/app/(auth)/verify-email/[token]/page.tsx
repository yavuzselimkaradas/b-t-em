import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, XCircle } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { verifyEmail } from "@/lib/server/actions/email-verification";
import { Button } from "@/components/ui/button";
import { isMessageKey } from "@/lib/message-key";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.verifyEmail");
  return { title: t("title") };
}

/**
 * Consumes the email-verification token SERVER-SIDE, directly on page
 * load — unlike `/reset-password/[token]`, there's no separate form step to
 * defer to: visiting this link IS the whole action (no additional data to
 * collect from the person), so there's nothing meaningful to gate behind a
 * button click.
 *
 * Accepted tradeoff: an email client's link-prefetching/malware-scanning
 * (Outlook Safe Links, some corporate gateways) could consume the token
 * before the person actually clicks it, making a legitimate click show
 * "invalid link" right after. This is the standard, widely-accepted
 * tradeoff for a one-shot verification link across the industry — the
 * stakes are low (worst case: click "resend" on the reminder banner and try
 * again) unlike a password-reset link, which deliberately stays a two-step
 * (load page → submit form) flow instead for exactly this reason.
 */
export default async function VerifyEmailTokenPage(props: PageProps<"/verify-email/[token]">) {
  const { token } = await props.params;
  const t = await getTranslations("auth.verifyEmail");
  const tErrors = await getTranslations();

  const result = await verifyEmail({ token });

  if (result.success) {
    return (
      <div className="flex flex-col gap-6">
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-income/20 bg-income-soft px-3 py-2.5 text-sm text-foreground"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-income" aria-hidden />
          <span>{t("success")}</span>
        </div>
        <Button
          size="lg"
          nativeButton={false}
          render={<Link href="/dashboard">{t("goToDashboard")}</Link>}
        />
      </div>
    );
  }

  const errorText = isMessageKey(result.error) ? tErrors(result.error) : result.error;

  return (
    <div className="flex flex-col gap-6">
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
      >
        <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{errorText}</span>
      </div>
      <Button
        size="lg"
        variant="outline"
        nativeButton={false}
        render={<Link href="/dashboard">{t("goToDashboard")}</Link>}
      />
    </div>
  );
}
