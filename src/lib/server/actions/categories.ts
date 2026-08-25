"use server";

import type { Category } from "@prisma/client";

import { db } from "@/lib/server/db";
import { auth } from "@/lib/server/auth";
import { categorySchema, type CategoryInput } from "@/lib/validation/category";

// STABLE KEYS (`errors.<camelCase>`), not translated text — this file never
// imports next-intl; the client resolves these via `messages/{locale}.json`'s
// `errors` namespace. `errors.unauthenticated` / `errors.validationFailed`
// are shared with other action files (identical Turkish source text).
const UNAUTHENTICATED_MESSAGE = "errors.unauthenticated";
const DUPLICATE_MESSAGE = "errors.categoryDuplicate";
const VALIDATION_ERROR_MESSAGE = "errors.validationFailed";
// Deliberately a DIFFERENT key from transactions.ts's own
// `NOT_FAMILY_MEMBER_MESSAGE` ("Bu aile için işlem oluşturamazsınız.") —
// different source text (category vs. transaction wording), not a dedup case.
const NOT_FAMILY_MEMBER_MESSAGE = "errors.notFamilyMemberCategory";

/**
 * Direct top-level `db.familyMember.*` lookup (never a nested include on
 * `User`/`Family` — CLAUDE.md) for "is `userId` a member (any role) of
 * `familyId`?", shared by `listCategories` and `createCategory`. Returns the
 * plain boolean rather than the row — neither caller needs the role itself,
 * only whether membership exists at all (Aşama 3.3 scope: any member, owner
 * or not, may read/create a family category).
 */
async function isFamilyMember(userId: string, familyId: string): Promise<boolean> {
  const membership = await db.familyMember.findUnique({
    where: { familyId_userId: { familyId, userId } },
    select: { id: true },
  });
  return membership !== null;
}

export type ListCategoriesResult =
  | { success: true; data: Category[] }
  | { success: false; error: string };

export type CategoryFieldErrors = Partial<Record<keyof CategoryInput, string[]>>;

export type CreateCategoryResult =
  | { success: true; data: Category }
  | { success: false; error: string; fieldErrors?: CategoryFieldErrors };

/**
 * Server Action: lists the categories the signed-in user may attach to a
 * transaction — the seeded global defaults (`isDefault: true`), any personal
 * categories of their own, and — Aşama 3.3, when `familyId` is passed — the
 * shared categories of a family they belong to. Existing callers (Phase 2's
 * transaction form) pass nothing, so the family branch is inert for them and
 * behavior is unchanged.
 *
 * `familyId` (optional): if provided, the caller's membership in THAT family
 * is verified first (`isFamilyMember`, a direct `db.familyMember.*` call,
 * never a nested include on `User`/`Family`) — a non-member gets
 * `{ success: false }` rather than silently having the `familyId` filter
 * ignored, so a caller can't probe another family's category names by
 * guessing its id.
 *
 * `db.category.findMany` is a top-level call on `Category`, so the
 * soft-delete read extension (lib/server/db.ts) applies automatically — a
 * soft-deleted category never appears here, matching `assertUsableCategory`
 * in lib/server/actions/transactions.ts.
 */
export async function listCategories(familyId?: string): Promise<ListCategoriesResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  if (familyId !== undefined) {
    const isMember = await isFamilyMember(session.user.id, familyId);
    if (!isMember) {
      return { success: false, error: NOT_FAMILY_MEMBER_MESSAGE };
    }
  }

  const categories = await db.category.findMany({
    where: {
      OR: [
        { isDefault: true },
        { userId: session.user.id },
        ...(familyId !== undefined ? [{ familyId }] : []),
      ],
    },
    orderBy: [{ type: "asc" }, { name: "asc" }],
  });

  return { success: true, data: categories };
}

/**
 * Server Action: creates a personal category (`isDefault: false`) owned by
 * the signed-in user, or — Aşama 3.3, when `familyId` is passed — a shared
 * category for a family they belong to.
 *
 * `familyId` (optional, new in Aşama 3.3): if provided, the caller's
 * membership in THAT family is verified first (`isFamilyMember`, same direct
 * `db.familyMember.*` check as `listCategories`) — a non-member gets
 * `NOT_FAMILY_MEMBER_MESSAGE` and nothing is created. `userId` is still set
 * to the caller's id either way (audit/"who added this" trail — the schema
 * allows both `userId` and `familyId` to be set simultaneously), but
 * `familyId` is what `assertUsableCategory`/`listCategories` key off of to
 * treat it as shared with the whole family rather than personal to the
 * creator.
 *
 * Rejects a case-insensitive (name, type) duplicate scoped to the same set
 * the category would be visible in: defaults + this user's own personal
 * categories, PLUS (if `familyId` given) that family's shared categories —
 * not a DB unique constraint (none exists in the schema for this), so this
 * check has a narrow race window between two rapid double-submits;
 * acceptable for a cosmetic annoyance (a duplicate-looking category name),
 * not a data integrity concern.
 */
export async function createCategory(
  input: unknown,
  familyId?: string
): Promise<CreateCategoryResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  if (familyId !== undefined) {
    const isMember = await isFamilyMember(session.user.id, familyId);
    if (!isMember) {
      return { success: false, error: NOT_FAMILY_MEMBER_MESSAGE };
    }
  }

  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as CategoryFieldErrors,
    };
  }
  const { name, type } = parsed.data;

  const existing = await db.category.findFirst({
    where: {
      type,
      name: { equals: name, mode: "insensitive" },
      OR: [
        { isDefault: true },
        { userId: session.user.id },
        ...(familyId !== undefined ? [{ familyId }] : []),
      ],
    },
    select: { id: true },
  });
  if (existing) {
    return { success: false, error: DUPLICATE_MESSAGE, fieldErrors: { name: [DUPLICATE_MESSAGE] } };
  }

  const category = await db.category.create({
    data: {
      name,
      type,
      userId: session.user.id,
      isDefault: false,
      familyId: familyId ?? null,
    },
  });

  return { success: true, data: category };
}
