import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { BudgetList } from "@/components/budgets/budget-list";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("budgets.page");
  return { title: t("title") };
}

/**
 * Server shell only, same split as transactions/page.tsx and
 * family/dashboard/page.tsx — `BudgetList` (Client Component) owns the
 * fetch/loading/error states itself so a database hiccup renders an in-page
 * retry, not a whole-route error boundary. Individual scope only, always
 * `canManage` (see `canManageBudget`'s doc comment in
 * lib/domain/budgets/evaluate.ts — an individual budget has exactly one
 * possible actor: the caller themself).
 *
 * Protected by src/proxy.ts's `"/budgets"` prefix (a budget limit inherently
 * requires an account — no guest-mode branch needed here, unlike
 * /dashboard and /transactions).
 */
export default async function BudgetsPage() {
  const t = await getTranslations("budgets.page");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {t("back")}
        </Link>
        <h1 className="font-display mt-2 text-3xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="mt-1.5 text-muted-foreground">{t("subtitle")}</p>
      </div>

      <BudgetList scope="individual" canManage={true} />
    </div>
  );
}
