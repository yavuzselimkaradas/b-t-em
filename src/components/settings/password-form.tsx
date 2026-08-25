"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { changePassword } from "@/lib/server/actions/settings";
import { changePasswordSchema, type ChangePasswordInput } from "@/lib/validation/settings";
import {
  FieldError,
  FormAlert,
  PasswordVisibilityToggle,
} from "@/components/auth/form-elements";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type PasswordFormInput = ChangePasswordInput & { confirmPassword: string };

/**
 * Client-only superset of `changePasswordSchema`: adds a confirm-password
 * field that never leaves the browser, same pattern as `register-form.tsx`'s
 * `registerFormSchema`. The two server-shared fields stay defined exactly
 * once, in `@/lib/validation/settings`, so client and server can't drift.
 * Built as a function (not a module-level constant) since its two
 * client-only error messages need `useTranslations` — memoized so it isn't
 * rebuilt every render.
 */
function usePasswordFormSchema() {
  const t = useTranslations("settings.password");
  return useMemo(
    () =>
      changePasswordSchema
        .extend({
          confirmPassword: z.string().min(1, { error: t("confirmRequired") }),
        })
        .refine((data) => data.newPassword === data.confirmPassword, {
          error: t("mismatch"),
          path: ["confirmPassword"],
        }),
    [t]
  );
}

/**
 * Same shape as `AccountForm`, with one difference: on success the form is
 * reset (`reset()`) rather than left holding the values — password fields
 * are sensitive and shouldn't linger in the DOM/inputs once the change has
 * gone through. Also closes the show/hide toggles back to hidden so a
 * screen-over-the-shoulder glance after a successful change reveals
 * nothing.
 */
export function PasswordForm() {
  const router = useRouter();
  const t = useTranslations("settings.password");
  const tCommon = useTranslations("common");
  const passwordFormSchema = usePasswordFormSchema();
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PasswordFormInput>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const onSubmit = async (values: PasswordFormInput) => {
    setFormError(null);
    setSuccessMessage(null);
    try {
      const result = await changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });

      if (!result.success) {
        setFormError(result.error);
        if (result.fieldErrors) {
          for (const [field, messages] of Object.entries(result.fieldErrors)) {
            if (messages?.[0]) {
              setError(field as keyof ChangePasswordInput, { message: messages[0] });
            }
          }
        }
        return;
      }

      setSuccessMessage(t("success"));
      reset({ currentPassword: "", newPassword: "", confirmPassword: "" });
      setShowCurrentPassword(false);
      setShowNewPassword(false);
      setShowConfirmPassword(false);
      router.refresh();
    } catch {
      setFormError(tCommon("somethingWrong"));
    }
  };

  // See the same wrapper in `account-form.tsx` for why this isn't just
  // `handleSubmit(onSubmit)` — clears a stale success/error message on every
  // submit ATTEMPT, before the Zod resolver runs, so a leftover "Şifreniz
  // değiştirildi." can't sit next to a brand-new "Şifreler eşleşmiyor."
  const submitHandler = handleSubmit(onSubmit);

  return (
    <form
      onSubmit={(event) => {
        setFormError(null);
        setSuccessMessage(null);
        void submitHandler(event);
      }}
      noValidate
      className="flex flex-col gap-4"
    >
      <FormAlert message={formError} />
      {!formError && successMessage ? (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
          {successMessage}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="currentPassword">{t("currentLabel")}</Label>
        <div className="relative">
          <Input
            id="currentPassword"
            type={showCurrentPassword ? "text" : "password"}
            autoComplete="current-password"
            className="pr-9"
            aria-invalid={!!errors.currentPassword}
            {...register("currentPassword")}
          />
          <PasswordVisibilityToggle
            visible={showCurrentPassword}
            onToggle={() => setShowCurrentPassword((v) => !v)}
          />
        </div>
        <FieldError message={errors.currentPassword?.message} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="newPassword">{t("newLabel")}</Label>
        <div className="relative">
          <Input
            id="newPassword"
            type={showNewPassword ? "text" : "password"}
            autoComplete="new-password"
            className="pr-9"
            aria-invalid={!!errors.newPassword}
            {...register("newPassword")}
          />
          <PasswordVisibilityToggle
            visible={showNewPassword}
            onToggle={() => setShowNewPassword((v) => !v)}
          />
        </div>
        <FieldError message={errors.newPassword?.message} />
        {!errors.newPassword ? (
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirmPassword">{t("confirmLabel")}</Label>
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

      <Button type="submit" disabled={isSubmitting} className="self-start">
        {isSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
        {t("submit")}
      </Button>
    </form>
  );
}
