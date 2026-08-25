import { z } from "zod";

// Same bound style as lib/validation/category.ts's MAX_NAME_LENGTH — a
// generous cap that rules out abuse (megabyte-long strings) without
// constraining any realistic family name ("Karadaş Ailesi", etc.).
const MAX_NAME_LENGTH = 50;

export const familyNameSchema = z
  .string()
  .trim()
  .min(1, { error: "Bu isim boş olamaz." })
  .max(MAX_NAME_LENGTH, { error: `Aile adı en fazla ${MAX_NAME_LENGTH} karakter olabilir.` });

export const createFamilySchema = z.object({
  name: familyNameSchema,
});

export type CreateFamilyInput = z.infer<typeof createFamilySchema>;

// `z.cuid()` — same id-validation pattern as
// lib/validation/transaction.ts's `transactionIdSchema` — for a
// `FamilyInvite.id` passed into `revokeInvite`.
export const familyInviteIdSchema = z.cuid({ error: "Geçersiz davet kimliği." });

// Same pattern, for a `FamilyMember.id` passed into `removeMember`.
export const familyMemberIdSchema = z.cuid({ error: "Geçersiz üye kimliği." });

// Aşama 3.5: for a `Family.id` passed into the family-scoped read/aggregation
// actions in lib/server/actions/family-transactions.ts (`listFamilyTransactions`
// etc). Same shape-only role as `familyIdSchema` in
// lib/validation/transaction.ts (which stays private to that file, scoped to
// `TransactionInput.familyId`) — whether the caller is actually a MEMBER of
// this family is an authorization question checked against the database in
// family-transactions.ts, not a shape question here.
export const familyIdSchema = z.cuid({ error: "Geçersiz aile kimliği." });

// The invite token itself is NOT a cuid — it's `randomBytes(32).toString
// ("base64url")` (see createInvite in actions/family.ts), which is a
// 43-character URL-safe base64 string, not shaped like a Prisma cuid. This
// only checks "non-empty, not absurdly long" rather than a strict format —
// the lookup itself (`db.familyInvite.findUnique({ where: { token } })`)
// is the real source of truth for "does this token exist", so a stricter
// regex here would just be duplicated logic that could drift from the
// actual generation format.
const MAX_TOKEN_LENGTH = 512;
export const familyInviteTokenSchema = z
  .string()
  .trim()
  .min(1, { error: "Davet bağlantısı geçersiz." })
  .max(MAX_TOKEN_LENGTH, { error: "Davet bağlantısı geçersiz." });

// For `updateTransactionSharing`'s single boolean input — Server Actions are
// reachable as plain network endpoints, so even a one-field boolean payload
// is re-validated here rather than trusted from its TS param type.
export const shareIndividualTransactionsSchema = z.boolean({
  error: "Geçersiz değer.",
});

// For `updateForceShareIndividualTransactions`'s single boolean input — same
// shape as `shareIndividualTransactionsSchema` above, kept as a SEPARATE
// export (rather than reused) because it validates a semantically distinct
// input belonging to a different actor/field (`Family.forceShareIndividualTransactions`,
// owner-only, vs. `FamilyMember.shareIndividualTransactions`, per-member).
export const forceShareIndividualTransactionsSchema = z.boolean({
  error: "Geçersiz değer.",
});

// For `updateMembersCanDeleteOwnTransactions`'s single boolean input — same
// shape as `forceShareIndividualTransactionsSchema` above, kept as a SEPARATE
// export for the same reason: a distinct owner-only `Family` field
// (`Family.membersCanDeleteOwnTransactions`), so a naming/scope mixup between
// the two toggles can't silently compile.
export const membersCanDeleteOwnTransactionsSchema = z.boolean({
  error: "Geçersiz değer.",
});
