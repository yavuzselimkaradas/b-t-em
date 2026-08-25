import { PiggyBank, Repeat, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Wordmark } from "@/components/brand/wordmark";

/**
 * The persistent left panel of the auth split-card: a dark "ledger" surface
 * with a ruled-paper texture, the wordmark, and the three real product
 * pillars. Purely decorative/informational — no interactive elements — so
 * it's a plain server component reused by (auth)/layout.tsx across
 * login/register/reset-password.
 */
export async function AuthBrandPanel() {
  const t = await getTranslations("auth.brandPanel");
  const FEATURES = [
    { icon: PiggyBank, title: t("features.budget.title"), description: t("features.budget.description") },
    {
      icon: Repeat,
      title: t("features.recurring.title"),
      description: t("features.recurring.description"),
    },
    { icon: Users, title: t("features.family.title"), description: t("features.family.description") },
  ];
  return (
    <div className="relative isolate flex h-full min-h-56 flex-col overflow-hidden bg-brand-deep px-8 py-8 text-brand-deep-foreground sm:px-10 sm:py-10">
      <div
        aria-hidden
        className="bg-ledger-lines pointer-events-none absolute inset-0 text-brand-deep-foreground/6"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-brand/40 blur-3xl"
      />

      <div className="relative">
        <Wordmark size="lg" tone="inverted" />
        <p className="mt-5 max-w-xs font-display text-xl leading-snug text-brand-deep-foreground/90">
          {t("tagline")}
        </p>
      </div>

      <ul className="relative mt-10 hidden flex-col gap-5 sm:flex">
        {FEATURES.map(({ icon: Icon, title, description }) => (
          <li key={title} className="flex items-start gap-3">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-deep-foreground/10">
              <Icon className="size-4" strokeWidth={2} />
            </span>
            <span>
              <span className="block text-sm font-medium text-brand-deep-foreground">
                {title}
              </span>
              <span className="block text-sm text-brand-deep-foreground/65">
                {description}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <p className="relative mt-10 text-xs text-brand-deep-foreground/50 sm:mt-auto sm:pt-10">
        {t("footer")}
      </p>
    </div>
  );
}
