import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { getMyFamily } from "@/lib/server/actions/family";
import { FamilyTrendView } from "@/components/family/family-trend-view";

export const metadata: Metadata = { title: "Aile Akışı" };

/**
 * Server shell for `FamilyTrendView` — same "resolve `familyId`, then hand
 * off to the Client Component" pattern as `/family/dashboard/page.tsx`
 * (no family yet / lookup failed → back to `/family`, which owns the
 * create-family / error UI for both cases). `type`/`from`/`to`/`granularity`
 * come from the `?...` query params the family dashboard's pie chart links
 * set — `FamilyTrendView` reads them itself via `useSearchParams`, hence
 * the required `<Suspense>` boundary (same reasoning as
 * `/transactions/trend/page.tsx`).
 *
 * Protected by src/proxy.ts's `"/family"` prefix, same as every other
 * `/family/*` route (a family plan inherently requires an account).
 */
export default async function FamilyTrendPage() {
  const result = await getMyFamily();

  if (!result.success || !result.data) {
    redirect("/family");
  }

  return (
    <div className="flex flex-col gap-6">
      <Suspense fallback={<FamilyTrendPageFallback />}>
        <FamilyTrendView familyId={result.data.id} />
      </Suspense>
    </div>
  );
}

function FamilyTrendPageFallback() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
          Aile Akışı
        </h1>
        <p className="mt-1.5 text-muted-foreground">Ailenin seçtiğin aralıktaki dağılımı.</p>
      </div>
      <div className="h-72 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}
