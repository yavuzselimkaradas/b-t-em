"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  FieldError,
  FormAlert,
  PasswordVisibilityToggle,
} from "@/components/auth/form-elements";
import { resetPassword } from "@/lib/server/actions/password-reset";
import { passwordSchema } from "@/lib/validation/auth";

type NewPasswordInput = { password: string; confirmPassword: string };

/** Client-only pair (password + confirm) — `password` reuses the exact same
 * `passwordSchema` `registerSchema` uses (lib/validation/auth.ts), so the
 * rules a person sees here (min length, letter+digit) never drift from
 * registration's. `confirmPassword` never leaves the browser. */
function useNewPasswordSchema() {
  const t = useTranslations("auth.newPassword");
  return useMemo(
    () =>
      z
        .object({
          password: passwordSchema,
          confirmPassword: z.string().min(1, { error: t("confirmRequired") }),
        })
        .refine((data) => data.password === data.confirmPassword, {
          error: t("mismatch"),
          path: ["confirmPassword"],
        }),
    [t]
  );
}

/**
 * Sets a new password using the single-use token embedded in the emailed
 * reset link (`token`, the dynamic route segment — see
 * `../[token]/page.tsx`). On success, shows a confirmation and a link to
 * `/login` rather than auto-signing-in: unlike registration (where the
 * password was just typed and is trivially known to be correct), a reset
 * flow is exactly the scenario where re-entering the new password once more
 * at `/login` is a reasonable, deliberate confirmation step — not a
 * redundant one.
 */
export function NewPasswordForm({ token }: { token: string }) {
  const t = useTranslations("auth.newPassword");
  const tCommon = useTranslations("common");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const newPasswordSchema = useNewPasswordSchema();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordInput>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const onSubmit = async (values: NewPasswordInput) => {
    setFormError(null);
    try {
      const result = await resetPassword({ token, password: values.password });
      if (!result.success) {
        setFormError(result.error);
        if (result.fieldErrors?.password?.[0]) {
          setError("password", { message: result.fieldErrors.password[0] });
        }
        return;
      }
      setSucceeded(true);
    } catch {
      setFormError(tCommon("somethingWrong"));
    }
  };

  if (succeeded) {
    return (
      <div className="flex flex-col gap-6">
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-income/20 bg-income-soft px-3 py-2.5 text-sm text-foreground"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-income" aria-hidden />
          <span>{t("success")}</span>
        </div>
        <Button
          size="lg"
          nativeButton={false}
          render={<Link href="/login">{t("goToLogin")}</Link>}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <FormAlert message={formError} />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">{t("passwordLabel")}</Label>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              className="pr-9"
              aria-invalid={!!errors.password}
              {...register("password")}
            />
            <PasswordVisibilityToggle
              visible={showPassword}
              onToggle={() => setShowPassword((v) => !v)}
            />
          </div>
          <FieldError message={errors.password?.message} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirmPassword">{t("confirmPasswordLabel")}</Label>
          <div className="relative">
            <Input
              id="confirmPassword"
              type={showConfirmPassword ? "text" : "password"}
              autoComplete="new-password"
              className="pr-9"
              aria-invalid={!!errors.confirmPassword}
              {...register("confirmPassword")}
            />
            <PasswordVisibilityToggle
              visible={showConfirmPassword}
              onToggle={() => setShowConfirmPassword((v) => !v)}
            />
          </div>
          <FieldError message={errors.confirmPassword?.message} />
        </div>

        <Button type="submit" size="lg" disabled={isSubmitting} className="mt-2">
          {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("submit")}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-medium text-brand hover:text-brand/80">
          {t("backToLogin")}
        </Link>
      </p>
    </div>
  );
}
