import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { auth } from "@/lib/server/auth";
import { GuestModeBanner } from "@/components/app/guest-mode-banner";
import { TransactionsView } from "@/components/transactions/transactions-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("transactions.page");
  return { title: t("title") };
}

/**
 * Server shell only — all data-fetching/interactivity lives in
 * `TransactionsView` (a Client Component that calls either the Server
 * Actions or the guest localStorage store itself, via
 * lib/client/transactions-source.ts). Kept this way deliberately, not
 * fetched here and passed down: a Server Component that awaited
 * `listTransactions()` directly would throw the whole page into an
 * unrecoverable error boundary if the database is ever unreachable, instead
 * of the in-page error state (with a retry button) `TransactionsView`
 * renders for exactly that case.
 *
 * This page IS where "account vs. guest" is decided (see CLAUDE.md "Misafir
 * modu" — this route is intentionally unprotected in src/proxy.ts): `auth()`
 * runs once, server-side, and the resulting `mode` is handed down as a prop
 * — `TransactionsView` and everything under it never re-derive the session
 * themselves.
 *
 * `useSearchParams` (used inside `TransactionsView` to read the filter/page
 * query params) requires a `<Suspense>` boundary per Next.js's App Router
 * rules.
 */
export default async function TransactionsPage() {
  const session = await auth();
  const mode = session?.user ? "account" : "guest";
  const t = await getTranslations("transactions.page");

  return (
    <div className="flex flex-col gap-6">
      {mode === "guest" ? <GuestModeBanner /> : null}
      <Suspense fallback={<TransactionsPageFallback title={t("title")} subtitle={t("subtitle")} />}>
        <TransactionsView mode={mode} />
      </Suspense>
    </div>
  );
}

function TransactionsPageFallback({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-1.5 text-muted-foreground">{subtitle}</p>
      </div>
      <div className="h-40 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}
