import type { Metadata } from "next";
import { Landmark } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { auth } from "@/lib/server/auth";
import { GuestModeBanner } from "@/components/app/guest-mode-banner";
import { Card, CardContent } from "@/components/ui/card";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("dashboard.page");
  return { title: t("title") };
}

// Bu sayfa da /transactions gibi kasıtlı olarak korumasız (bkz. src/proxy.ts,
// CLAUDE.md "Misafir modu") — oturum yoksa banner gösterilir, panel içeriği
// aynı minimal placeholder kalır (Aşama 5'te genişleyecek).
export default async function DashboardPage() {
  const session = await auth();
  const firstName = session?.user?.name?.split(" ")[0];
  const t = await getTranslations("dashboard");

  return (
    <div className="flex flex-col gap-6">
      {!session?.user ? <GuestModeBanner /> : null}
      <div>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
          {firstName ? t("greetingWithName", { name: firstName }) : t("greetingPlain")}
        </h1>
        <p className="mt-1.5 text-muted-foreground">{t("subtitle")}</p>
      </div>

      {/* Deliberate stub, not a real empty state: this screen exists in
          Aşama 1 purely to prove the auth flow end-to-end. The real
          dashboard (summary cards, category breakdown, recent
          transactions — with its own loading/empty/error states) lands in
          Aşama 5. */}
      <Card className="border-2 border-dashed border-border bg-transparent shadow-none ring-0">
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-brand-soft text-brand-soft-foreground">
            <Landmark className="size-6" strokeWidth={2} />
          </span>
          <div>
            <p className="font-medium text-foreground">{t("stub.title")}</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("stub.body")}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
