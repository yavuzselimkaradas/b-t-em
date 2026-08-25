"use client";

import Link from "next/link";
import { UserRound } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Non-dismissable notice shown on pages usable without an account
 * (/transactions, /dashboard — see CLAUDE.md "Misafir modu"). Deliberately
 * NOT closable: it's the only cue a guest has that their data lives in this
 * browser only, so it stays visible for the whole session rather than being
 * dismissed once and forgotten. Kept quiet (brand-tinted, not a warning
 * color) — this is an expected mode, not a problem.
 */
export function GuestModeBanner() {
  const t = useTranslations("app.guestBanner");
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-xl bg-accent px-4 py-3 text-sm text-accent-foreground sm:flex-row sm:items-center sm:gap-3"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-background/60">
        <UserRound className="size-3.5" strokeWidth={2.25} />
      </span>
      <p className="leading-relaxed">
        <span className="font-medium">{t("title")}</span> — {t("body")}
      </p>
      <Link
        href="/register"
        className="shrink-0 font-medium underline underline-offset-4 hover:no-underline sm:ml-auto"
      >
        {t("cta")}
      </Link>
    </div>
  );
}
