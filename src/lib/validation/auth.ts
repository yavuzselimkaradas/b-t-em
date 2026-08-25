import { z } from "zod";

// Shared password policy: at least 8 characters, at least one letter and one
// number. Kept intentionally simple for Phase 1 — revisit if the product
// docs call for a stricter policy later.
//
// bcrypt's real limit is 72 BYTES, not 72 characters — multi-byte UTF-8
// characters (Turkish ç/ğ/ı/ö/ş/ü are 2 bytes each) mean a string well under
// 72 *characters* can still exceed 72 *bytes* and get silently truncated by
// bcrypt, causing distinct passwords to hash identically. The character
// `.max()` below is just a cheap client-side pre-check for a fast UI error;
// the `.refine()` byte check is the actual guard.
// Exported (not just used inline below) so `lib/validation/settings.ts` can
// reuse the exact same rule for `changePassword`'s `newPassword` field
// instead of re-deriving it and risking drift from the registration policy.
// Every `error:` value in this file is a STABLE KEY (`validation.auth.*`),
// not display text — see lib/validation/transaction.ts's "i18n note" for the
// same discipline applied there. `emailSchema`'s `maxLength`-dependent
// message below is the one case with a value baked into the translated
// text (`validation.auth.emailMax`) rather than interpolated at parse time —
// every call site in this codebase passes `maxLength: 255`, so the message
// bakes in "255" directly; update both locale files if that ever changes.
export const passwordSchema = z
  .string()
  .min(8, { error: "validation.auth.passwordMin" })
  .max(64, { error: "validation.auth.passwordMax" })
  .refine((v) => Buffer.byteLength(v, "utf8") <= 72, {
    error: "validation.auth.passwordTooLong",
  })
  .regex(/[a-zA-Z]/, { error: "validation.auth.passwordLetter" })
  .regex(/[0-9]/, { error: "validation.auth.passwordDigit" });

// Normalize (trim + lowercase) BEFORE validating email format, not after.
// `z.email()` validates the format of whatever schema is piped into it — if
// `.trim()`/`.toLowerCase()` ran after the format check instead of before,
// a leading/trailing-whitespace email would fail validation before ever
// being cleaned up. This mostly doesn't bite the web form (the browser's
// `<input type=email>` trims automatically) but matters for any other
// caller of these shared schemas — mobile client, a future public API,
// curl/Postman — hence fixing it here rather than relying on UI behavior.
// Exported for the same reason as `passwordSchema` above — reused verbatim
// by `lib/validation/settings.ts`'s `updateProfile` schema so the "what's a
// valid email" rule (including the trim-before-format-check ordering, see
// comment above) can never drift between registration and profile editing.
export function emailSchema(maxLength?: number) {
  let base = z.string().trim().toLowerCase();
  if (maxLength) {
    base = base.max(maxLength, { error: "validation.auth.emailMax" });
  }
  return base.pipe(z.email({ error: "validation.auth.emailFormat" }));
}

// Exported for the same reason — reused verbatim by
// `lib/validation/settings.ts`'s `updateProfile` schema.
export const nameSchema = z
  .string()
  .trim()
  .min(2, { error: "validation.auth.nameMin" })
  .max(100, { error: "validation.auth.nameMax" });

export const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema(255),
  password: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema(),
  password: z.string().min(1, { error: "validation.auth.passwordRequired" }),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const requestPasswordResetSchema = z.object({
  email: emailSchema(255),
});

export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

// A raw AuthToken is `randomBytes(32).toString("hex")` — always exactly 64
// hex characters (see src/lib/server/auth-tokens.ts). Bounds are a cheap
// shape check before ever touching the database, not a security boundary
// by themselves (consumeAuthToken's hash lookup is that boundary).
const authTokenSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "validation.auth.tokenInvalid" });

export const resetPasswordSchema = z.object({
  token: authTokenSchema,
  password: passwordSchema,
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const verifyEmailSchema = z.object({
  token: authTokenSchema,
});

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
