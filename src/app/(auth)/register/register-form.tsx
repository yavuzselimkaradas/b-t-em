"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { registerUser } from "@/lib/server/actions/auth";
import { registerSchema, type RegisterInput } from "@/lib/validation/auth";
import {
  FieldError,
  FormAlert,
  PasswordVisibilityToggle,
} from "@/components/auth/form-elements";

type RegisterFormInput = RegisterInput & { confirmPassword: string };

/**
 * Client-only superset of the server's registerSchema: adds a
 * confirm-password field that never leaves the browser. The three shared
 * fields (name/email/password) stay defined exactly once, in
 * `@/lib/validation/auth`, so client and server never drift apart. Built as
 * a function (not a module-level constant) since its two client-only error
 * messages need `useTranslations` — memoized so it isn't rebuilt every
 * render.
 */
function useRegisterFormSchema() {
  const t = useTranslations("auth.register");
  return useMemo(
    () =>
      registerSchema
        .extend({
          confirmPassword: z.string().min(1, { error: t("confirmRequired") }),
        })
        .refine((data) => data.password === data.confirmPassword, {
          error: t("mismatch"),
          path: ["confirmPassword"],
        }),
    [t]
  );
}

export function RegisterForm() {
  const router = useRouter();
  const t = useTranslations("auth.register");
  const tCommon = useTranslations("common");
  const registerFormSchema = useRegisterFormSchema();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormInput>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });

  const onSubmit = async (values: RegisterFormInput) => {
    setFormError(null);
    try {
      const result = await registerUser({
        name: values.name,
        email: values.email,
        password: values.password,
      });

      if (!result.success) {
        setFormError(result.error);
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            if (messages?.[0]) {
              setError(field as keyof RegisterFormInput, { message: messages[0] });
            }
          }
        }
        return;
      }

      // Account created — log the new user in right away rather than
      // sending them back to /login.
      const signInResult = await signIn("credentials", {
        email: values.email,
        password: values.password,
        redirect: false,
      });

      if (!signInResult || signInResult.error) {
        setFormError(t("autoSignInFailed"));
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      // registerUser is a Server Action — a thrown error there (e.g. the
      // database being unreachable) surfaces here as a rejected promise
      // rather than a field-level result. Never leave the person looking at
      // a stuck button with no explanation.
      setFormError(tCommon("somethingWrong"));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">
          {t("heading")}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
        <FormAlert message={formError} />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">{t("nameLabel")}</Label>
          <Input
            id="name"
            type="text"
            autoComplete="name"
            placeholder="Ayşe Yılmaz"
            aria-invalid={!!errors.name}
            {...register("name")}
          />
          <FieldError message={errors.name?.message} />
        </div>

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
          {!errors.password ? (
            <p className="text-xs text-muted-foreground">{t("passwordHint")}</p>
          ) : null}
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
        {t("haveAccount")}{" "}
        <Link href="/login" className="font-medium text-brand hover:text-brand/80">
          {t("signInLink")}
        </Link>
      </p>
    </div>
  );
}
