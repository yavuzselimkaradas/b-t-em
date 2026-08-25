import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { auth } from "@/lib/server/auth";
import { GuestModeBanner } from "@/components/app/guest-mode-banner";
import { TrendView } from "@/components/transactions/trend-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("transactions.trend");
  return { title: t("metaTitle") };
}

/**
 * Server shell only — same reasoning as `transactions/page.tsx`: `auth()`
 * decides account-vs-guest mode once, here, and everything else (fetching,
 * aggregation, the chart) lives in the Client Component so a DB hiccup
 * shows the page's own error state instead of crashing the route.
 *
 * `type` (INCOME/EXPENSE) comes from the `?type=` query param the pie
 * chart's title links set — `TrendView` reads it itself via
 * `useSearchParams` (hence the required `<Suspense>` boundary), defaulting
 * to EXPENSE if missing/invalid rather than erroring, since landing here
 * with no/garbled query param is a plausible way in (typed URL, back
 * button after a redirect, etc.).
 */
export default async function TransactionTrendPage() {
  const session = await auth();
  const mode = session?.user ? "account" : "guest";
  const t = await getTranslations("transactions.trend");

  return (
    <div className="flex flex-col gap-6">
      {mode === "guest" ? <GuestModeBanner /> : null}
      <Suspense
        fallback={<TrendPageFallback title={t("metaTitle")} subtitle={t("fallbackSubtitle")} />}
      >
        <TrendView mode={mode} />
      </Suspense>
    </div>
  );
}

function TrendPageFallback({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-1.5 text-muted-foreground">{subtitle}</p>
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}
