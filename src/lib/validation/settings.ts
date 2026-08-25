import { z } from "zod";
import { Currency } from "@prisma/client";

import { nameSchema, emailSchema, passwordSchema } from "./auth";

/**
 * `updateProfile`'s input shape: `name` + `email`. Deliberately reuses
 * `nameSchema`/`emailSchema` from `lib/validation/auth.ts` verbatim (same
 * min/max length, same trim-before-lowercase-before-format-check ordering)
 * rather than re-deriving the rules here — a profile-edit account should
 * never be able to end up in a state a fresh registration couldn't have
 * produced, and duplicating the rules would risk the two silently drifting
 * apart over time.
 */
export const updateProfileSchema = z.object({
  name: nameSchema,
  email: emailSchema(255),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * `changePassword`'s input shape. `newPassword` reuses `passwordSchema` from
 * `lib/validation/auth.ts` verbatim — same policy (min 8 chars, letter +
 * digit, byte-length guard for bcrypt's 72-byte limit) as registration, so a
 * password change can never produce a weaker password than registration
 * would have allowed. `currentPassword` only needs to be non-empty here —
 * whether it's actually correct is checked against the stored hash in
 * `lib/server/actions/settings.ts`, not by shape here.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, { error: "validation.settings.currentPasswordRequired" }),
  newPassword: passwordSchema,
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * `updatePreferences`'s input shape.
 *
 * `preferredLanguage`: the `User.preferredLanguage` column is a plain
 * `String @default("tr")` in schema.prisma (not a Prisma enum — i18n/next-intl
 * isn't wired up yet, see the doc comment in
 * `lib/server/actions/settings.ts`), but this Zod schema still only accepts
 * the two values the product actually supports today ("tr" | "en") — the
 * column's looser DB type is not a reason to accept arbitrary strings at the
 * validation boundary.
 *
 * `preferredCurrency`: matches the Prisma `Currency` enum (`TRY` | `USD` |
 * `EUR`) exactly, same `z.enum(Currency, ...)` pattern already used for
 * `Transaction.currency` in `lib/validation/transaction.ts`.
 */
export const updatePreferencesSchema = z.object({
  preferredLanguage: z.enum(["tr", "en"], { error: "validation.settings.languageInvalid" }),
  preferredCurrency: z.enum(Currency, { error: "validation.settings.currencyInvalid" }),
});

export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

/**
 * `deleteMyAccount`'s input shape — just the current password, same
 * "non-empty only, correctness checked against the stored hash" contract as
 * `changePasswordSchema.currentPassword` (reuses the exact same key, this is
 * the same field/rule, not a new one).
 */
export const deleteAccountSchema = z.object({
  password: z.string().min(1, { error: "validation.settings.currentPasswordRequired" }),
});

export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
