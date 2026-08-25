"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { deleteMyAccount } from "@/lib/server/actions/account-deletion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  FieldError,
  FormAlert,
  PasswordVisibilityToggle,
} from "@/components/auth/form-elements";

type DeleteAccountInput = { password: string };

/**
 * Settings' "Danger zone" card — the ONLY entry point to `deleteMyAccount`
 * (lib/server/actions/account-deletion.ts). Deliberately its own bottom-of-
 * page card, visually distinct (`border-destructive/30`) from the ordinary
 * account/password/preferences cards above it, so it can never be mistaken
 * for a routine settings toggle.
 *
 * The confirmation dialog requires re-entering the CURRENT password (not
 * just a "yes I'm sure" click) — the same extra-confirmation shape
 * `PasswordForm`'s change-password flow already uses, applied here because
 * this action is irreversible and destroys every row the account owns; see
 * `deleteMyAccount`'s doc comment for the full reasoning.
 */
export function DeleteAccountSection() {
  const t = useTranslations("settings.deleteAccount");
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const schema = z.object({
    password: z.string().min(1, { error: t("passwordRequired") }),
  });

  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors },
  } = useForm<DeleteAccountInput>({
    resolver: zodResolver(schema),
    defaultValues: { password: "" },
  });

  const closeDialog = (next: boolean) => {
    if (isDeleting) return;
    setOpen(next);
    if (!next) {
      setFormError(null);
      reset();
    }
  };

  const onSubmit = async (values: DeleteAccountInput) => {
    setFormError(null);
    setIsDeleting(true);
    try {
      const result = await deleteMyAccount({ password: values.password });
      if (!result.success) {
        setFormError(result.error);
        if (result.fieldErrors?.password?.[0]) {
          setError("password", { message: result.fieldErrors.password[0] });
        }
        return;
      }

      // The account row (and every session-independent trace of it) is
      // already gone server-side at this point — this just clears the now-
      // dangling JWT session cookie and sends the browser somewhere that
      // doesn't assume a signed-in identity. `redirect: true` (the
      // default) is exactly right here: unlike a form save, there is no
      // page left to stay on.
      await signOut({ callbackUrl: "/" });
    } catch {
      setFormError(tCommon("somethingWrong"));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle className="text-destructive">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
          {t("openButton")}
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={closeDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <div className="flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlert className="size-4.5" strokeWidth={2.25} />
            </div>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
            <FormAlert message={formError} />

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-account-password">{t("passwordLabel")}</Label>
              <div className="relative">
                <Input
                  id="delete-account-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
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

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => closeDialog(false)}
                disabled={isDeleting}
              >
                {tCommon("cancel")}
              </Button>
              <Button type="submit" variant="destructive" disabled={isDeleting}>
                {isDeleting ? <Loader2 className="size-4 animate-spin" /> : null}
                {t("confirmButton")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
