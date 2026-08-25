import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { getMyProfile } from "@/lib/server/actions/settings";
import { isMessageKey } from "@/lib/message-key";
import { AccountForm } from "@/components/settings/account-form";
import { PasswordForm } from "@/components/settings/password-form";
import { PreferencesForm } from "@/components/settings/preferences-form";
import { DeleteAccountSection } from "@/components/settings/delete-account-section";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.page");
  return { title: t("title") };
}

/**
 * Protected by src/proxy.ts's `"/settings"` prefix (an account is inherently
 * required to have profile/password/preferences to edit — see CLAUDE.md
 * "Misafir modu"), so no guest-mode branching is needed here the way
 * transactions/page.tsx has.
 *
 * Same "one Server Component, three independent Client Component forms"
 * shape as `/family` (`CreateFamilyForm`/`InviteManager`/`MemberList`) —
 * each card below owns its own success/error state and calls
 * `router.refresh()` on success, which re-runs this Server Component and
 * re-fetches `getMyProfile()` so every card reflects the latest saved
 * values, not just the one that was just submitted.
 */
export default async function SettingsPage() {
  const result = await getMyProfile();
  const t = await getTranslations("settings");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {t("page.back")}
        </Link>
        <h1 className="font-display mt-2 text-3xl font-semibold tracking-tight text-foreground">
          {t("page.title")}
        </h1>
        <p className="mt-1.5 text-muted-foreground">{t("page.subtitle")}</p>
      </div>

      {!result.success ? (
        <ErrorState message={result.error} />
      ) : (
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("account.title")}</CardTitle>
              <CardDescription>{t("account.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <AccountForm
                initialProfile={{ name: result.data.name, email: result.data.email }}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("password.title")}</CardTitle>
              <CardDescription>{t("password.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <PasswordForm />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("preferences.title")}</CardTitle>
              <CardDescription>{t("preferences.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <PreferencesForm
                initialPreferences={{
                  preferredLanguage:
                    result.data.preferredLanguage === "en" ? "en" : "tr",
                  preferredCurrency: result.data.preferredCurrency,
                }}
              />
            </CardContent>
          </Card>

          <DeleteAccountSection />
        </div>
      )}
    </div>
  );
}

/** `message` is a Server Action result (`getMyProfile`'s `error`) — a
 * next-intl KEY today (its only failure mode is `errors.unauthenticated`),
 * resolved the same way `FormAlert`/`FieldError` do (see lib/message-key.ts)
 * rather than assumed to always be a key, so this stays correct even if a
 * future failure mode returns literal text instead. */
async function ErrorState({ message }: { message: string }) {
  const t = await getTranslations("settings.page");
  const tRoot = await getTranslations();
  const resolved = isMessageKey(message) ? tRoot(message) : message;

  return (
    <Card className="border-2 border-dashed border-destructive/30 bg-transparent shadow-none ring-0">
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertCircle className="size-6" strokeWidth={2} />
        </span>
        <div>
          <p className="font-medium text-foreground">{t("loadErrorTitle")}</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">{resolved}</p>
        </div>
        <Button variant="outline" nativeButton={false} render={<Link href="/settings">{t("retry")}</Link>} />
      </CardContent>
    </Card>
  );
}
