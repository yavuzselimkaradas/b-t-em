import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { AuthBrandPanel } from "@/components/auth/auth-brand-panel";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  const t = await getTranslations("auth");
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-background px-4 py-10 sm:px-6">
      <div className="flex w-full max-w-4xl flex-col gap-5">
        <Link
          href="/"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {t("backHome")}
        </Link>

        <div className="grid overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10 shadow-sm sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <AuthBrandPanel />
          <div className="flex flex-col justify-center px-6 py-10 sm:px-10 sm:py-12">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
