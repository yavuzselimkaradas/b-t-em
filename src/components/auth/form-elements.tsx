"use client";

import { AlertCircle, Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { isMessageKey } from "@/lib/message-key";

/** Resolves a `message` that's either a next-intl key or literal text into
 * text ready to render — shared by `FormAlert` and `FieldError` so the two
 * never drift on what counts as "looks like a key". See `isMessageKey`'s
 * doc comment (lib/message-key.ts) for why a message can be either. */
function useResolvedMessage(message: string | null | undefined): string | null {
  // Namespace-less: `t(key)` below is called with the FULL dotted key
  // (e.g. "errors.unauthenticated"), not a sub-namespace — every message key
  // this app hands to these components is already rooted at the top level.
  const t = useTranslations();
  if (!message) return null;
  return isMessageKey(message) ? t(message) : message;
}

/** Top-of-form banner for a general (non-field-specific) error message. */
export function FormAlert({
  message,
  className,
}: {
  message?: string | null;
  className?: string;
}) {
  const resolved = useResolvedMessage(message);
  if (!resolved) return null;
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive",
        className
      )}
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{resolved}</span>
    </div>
  );
}

/** Inline error text rendered directly under a field. */
export function FieldError({ message }: { message?: string }) {
  const resolved = useResolvedMessage(message);
  if (!resolved) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {resolved}
    </p>
  );
}

/** Eye / eye-off toggle button, positioned inside a `relative` wrapper. */
export function PasswordVisibilityToggle({
  visible,
  onToggle,
}: {
  visible: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("auth.passwordVisibility");
  return (
    <button
      type="button"
      onClick={onToggle}
      tabIndex={-1}
      aria-label={visible ? t("hide") : t("show")}
      className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted-foreground transition-colors hover:text-foreground"
    >
      {visible ? (
        <EyeOff className="size-4" aria-hidden />
      ) : (
        <Eye className="size-4" aria-hidden />
      )}
    </button>
  );
}
