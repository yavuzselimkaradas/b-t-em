"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError, FormAlert } from "@/components/auth/form-elements";
import { requestPasswordReset } from "@/lib/server/actions/password-reset";

type ResetRequestInput = { email: string };

/** Reuses `validation.auth.emailFormat` (already filled in both locales,
 * see CLAUDE.md) instead of a new key here — this client-only schema's
 * wording is an exact match for that existing one, so there's no reason to
 * duplicate the string under `auth.resetPassword.*`. */
function useResetRequestSchema() {
  const t = useTranslations();
  return useMemo(
    () =>
      z.object({
        email: z.email({ error: t("validation.auth.emailFormat") }).trim().toLowerCase(),
      }),
    [t]
  );
}

/**
 * Real password-reset request flow: submits to `requestPasswordReset`
 * (lib/server/actions/password-reset.ts), which ALWAYS resolves
 * `{ success: true }` for a well-formed email regardless of whether an
 * account with that address exists (account-enumeration defense — see that
 * action's doc comment) — so the success state below is shown unconditionally
 * on a successful call, never branched on "was this email real". A
 * rate-limit/validation failure is the only case that shows `FormAlert`
 * instead.
 */
export function ResetPasswordForm() {
  const t = useTranslations("auth.resetPassword");
  const tCommon = useTranslations("common");
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const resetRequestSchema = useResetRequestSchema();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetRequestInput>({
    resolver: zodResolver(resetRequestSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = async (values: ResetRequestInput) => {
    setFormError(null);
    try {
      const result = await requestPasswordReset({ email: values.email });
      if (!result.success) {
        setFormError(result.error);
        return;
      }
      setSubmitted(true);
    } catch {
      setFormError(tCommon("somethingWrong"));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {submitted ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2.5 text-sm text-foreground"
        >
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>{t("notice")}</span>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <FormAlert message={formError} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">{t("emailLabel")}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder={t("emailPlaceholder")}
              aria-invalid={!!errors.email}
              {...register("email")}
            />
            <FieldError message={errors.email?.message} />
          </div>

          <Button type="submit" size="lg" disabled={isSubmitting} className="mt-2">
            {t("submit")}
          </Button>
        </form>
      )}

      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-medium text-brand hover:text-brand/80">
          {t("backToLogin")}
        </Link>
      </p>
    </div>
  );
}
