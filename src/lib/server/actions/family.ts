"use server";

import { randomBytes } from "crypto";

import { Prisma, type Role } from "@prisma/client";

import { db } from "@/lib/server/db";
import { auth } from "@/lib/server/auth";
import { canAcceptInvite, canCreateFamily, selectSuccessorOwner } from "@/lib/domain/family";
import {
  createFamilySchema,
  familyInviteIdSchema,
  familyInviteTokenSchema,
  familyMemberIdSchema,
  forceShareIndividualTransactionsSchema,
  membersCanDeleteOwnTransactionsSchema,
  shareIndividualTransactionsSchema,
} from "@/lib/validation/family";

const UNAUTHENTICATED_MESSAGE = "Bu işlem için giriş yapmanız gerekiyor.";
const VALIDATION_ERROR_MESSAGE = "Girdiğiniz bilgileri kontrol edin.";
const ALREADY_IN_FAMILY_MESSAGE =
  "Zaten bir ailenin üyesisiniz. Yeni bir aile oluşturmadan önce mevcut ailenizden ayrılmalısınız.";
const NOT_OWNER_MESSAGE = "Bu işlemi yalnızca ailenin sahibi yapabilir.";
const INVITE_NOT_FOUND_MESSAGE = "Davet bulunamadı.";
const MEMBER_NOT_FOUND_MESSAGE = "Üye bulunamadı.";
const OWNER_CANNOT_REMOVE_SELF_MESSAGE = "Sahip kendini çıkaramaz.";
const NOT_IN_FAMILY_MESSAGE = "Bir aile planında değilsiniz.";
const SHARING_LOCKED_BY_OWNER_MESSAGE =
  "Ailenin sahibi bu ayarı üyeler için kilitledi. Yalnızca sahip değiştirebilir.";

// 7 gün — proje dokümanının davet linki geçerlilik süresi kararı.
const INVITE_EXPIRY_DAYS = 7;

const ACCEPT_INVITE_REJECTION_MESSAGES: Record<
  Exclude<ReturnType<typeof canAcceptInvite>, { ok: true }>["reason"],
  string
> = {
  expired: "Bu davetin süresi dolmuş.",
  already_accepted: "Bu davet zaten kullanılmış.",
  already_in_family: "Zaten bir aile planındasınız.",
};

/**
 * Sentinel thrown INSIDE the `$transaction` callback in `acceptInvite` to
 * abort the transaction when the atomic `updateMany` guard (see comment at
 * its call site) finds the invite was already claimed by a concurrent
 * request. Never escapes to a caller outside this file — caught immediately
 * around the `$transaction` call and translated into the normal
 * `FamilyActionResult` error shape.
 */
class InviteAlreadyClaimedError extends Error {}

/**
 * Centralizes the "is this user the OWNER of a family?" check shared by
 * `createInvite`, `listActiveInvites`, and `revokeInvite` — a single place
 * to answer "who is allowed to manage this family's invites, and did we
 * check?" rather than re-deriving the same query at each call site.
 * Direct top-level `db.familyMember.*` call (no nested include on
 * `User`/`Family`), same discipline as `createFamily`/`getMyFamily` above.
 */
async function assertIsFamilyOwner(
  userId: string
): Promise<{ ok: true; familyId: string } | { ok: false; error: string }> {
  const membership = await db.familyMember.findFirst({
    where: { userId, role: "OWNER" },
    select: { familyId: true },
  });
  if (!membership) {
    return { ok: false, error: NOT_OWNER_MESSAGE };
  }
  return { ok: true, familyId: membership.familyId };
}

export type FamilyFieldErrors = { name?: string[] };

/**
 * A single row from a family's member list, shaped for direct UI rendering
 * (name already joined in, not just a bare `userId`) — see `getMyFamily`'s
 * doc comment for why the `user` nested include used to build this is safe
 * under CLAUDE.md's soft-delete rule (it targets `User`, not
 * `Transaction`/`Category`).
 */
export interface FamilyMemberInfo {
  id: string;
  userId: string;
  userName: string;
  role: Role;
  joinedAt: Date;
  /** This member's own preference for FUTURE transactions: while true, any
   * new individual (`familyId: null`) transaction they create gets
   * permanently stamped (`Transaction.sharedFamilyId`, see
   * createTransaction in lib/server/actions/transactions.ts) so it's
   * included — read-only — in this family's shared views
   * (lib/server/actions/family-transactions.ts). Flipping this does NOT
   * retroactively show or hide anything already created; see
   * `updateTransactionSharing`. Each member controls only their own row. */
  shareIndividualTransactions: boolean;
}

export interface FamilyData {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
  members: FamilyMemberInfo[];
  /** Owner-controlled kill switch (default `false`). While `true`: every
   * MEMBER's `shareIndividualTransactions` toggle is locked (they can no
   * longer change it — see `updateTransactionSharing`'s new rejection
   * branch), and every CURRENT member's individual (`familyId: null`)
   * transactions are treated as shared in family-wide reads
   * (`lib/server/actions/family-transactions.ts`) regardless of each
   * member's own toggle value. The OWNER's own toggle is never locked by
   * this — only the switch itself (`updateForceShareIndividualTransactions`)
   * is owner-only. */
  forceShareIndividualTransactions: boolean;
  /** Owner-controlled toggle (default `false`). While `true`: a MEMBER may
   * soft-delete a REAL family transaction (`Transaction.familyId` set to
   * this family) that THEY THEMSELVES created — never another member's or
   * the owner's row. The OWNER's own delete rights are unaffected either
   * way (always full). See `canDeleteTransaction`
   * (lib/domain/transactions/authorization.ts) for the exact rule and
   * `updateMembersCanDeleteOwnTransactions` below for the owner-only
   * switch. */
  membersCanDeleteOwnTransactions: boolean;
}

export type FamilyActionResult =
  | { success: true; data: FamilyData }
  | { success: false; error: string; fieldErrors?: FamilyFieldErrors };

export type GetMyFamilyResult =
  | { success: true; data: FamilyData | null }
  | { success: false; error: string };

/**
 * Server Action: creates a `Family` owned by the signed-in user, plus an
 * `OWNER`-role `FamilyMember` row for them, in a single `$transaction` (so a
 * caller never observes a `Family` with no owning member, or vice versa).
 *
 * Contract (relied on by frontend-developer / mobile-developer):
 *  - Input: `unknown`, conceptually a bare `name: string` — Server Actions
 *    are reachable as plain network endpoints, so the TS param type on the
 *    client is not a runtime guarantee (same reasoning as
 *    lib/server/actions/transactions.ts). Re-validated here with
 *    `createFamilySchema` (non-empty after trim, max 50 chars).
 *  - Auth: requires a session (`auth()`); returns `{ success: false }` with
 *    a generic message if absent. `ownerId` is ALWAYS derived from the
 *    session, never from the input.
 *  - Membership rule (`canCreateFamily`, lib/domain/family/authorization.ts):
 *    a user may belong to at most one family at a time. If a `FamilyMember`
 *    row already exists for this user (as owner OR member, in ANY family),
 *    this rejects with `ALREADY_IN_FAMILY_MESSAGE` and does not touch the DB
 *    further.
 *  - Output: `FamilyActionResult`. On success, `{ success: true, data }`
 *    where `data.members` contains exactly one entry (the caller, as
 *    `OWNER`) — shaped identically to `getMyFamily`'s result so the caller
 *    can render immediately without a follow-up fetch. On validation
 *    failure, `{ success: false, error, fieldErrors: { name: [...] } }`
 *    mirroring Zod's `flatten().fieldErrors`.
 *
 * RACE HANDLING: the membership check below and the `$transaction` that
 * follows are not atomic with respect to a SECOND concurrent `createFamily`
 * call from the same user — but `FamilyMember` has a DB-level
 * `@@unique([userId])` constraint (schema.prisma, added specifically for
 * this), so at most one of two racing calls can ever commit its
 * `familyMember.create`; the loser's `$transaction` fails on `P2002` and is
 * caught below, rolling back its `family.create` too (no orphaned `Family`
 * row). Same pattern `acceptInvite` uses for its own concurrent-accept race.
 */
export async function createFamily(input: unknown): Promise<FamilyActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsed = createFamilySchema.safeParse({ name: input });
  if (!parsed.success) {
    return {
      success: false,
      error: VALIDATION_ERROR_MESSAGE,
      fieldErrors: parsed.error.flatten().fieldErrors as FamilyFieldErrors,
    };
  }
  const { name } = parsed.data;

  // Direct top-level `db.familyMember.*` call, never reached via a nested
  // include on `User`/`Family` — not a soft-delete concern for this model
  // (FamilyMember has no `deletedAt`), but keeping the same direct-query
  // discipline CLAUDE.md mandates for Transaction/Category avoids a
  // future accidental copy-paste into a genuinely soft-deleted model.
  const existingMembership = await db.familyMember.findFirst({
    where: { userId: session.user.id },
    select: { id: true },
  });

  if (!canCreateFamily(existingMembership)) {
    return { success: false, error: ALREADY_IN_FAMILY_MESSAGE };
  }

  let family: Awaited<ReturnType<typeof db.family.create>>;
  let ownerMember: Prisma.FamilyMemberGetPayload<{ include: { user: { select: { name: true } } } }>;
  try {
    ({ family, ownerMember } = await db.$transaction(async (tx) => {
      const family = await tx.family.create({
        data: { name, ownerId: session.user.id },
      });
      const ownerMember = await tx.familyMember.create({
        data: { familyId: family.id, userId: session.user.id, role: "OWNER" },
        include: { user: { select: { name: true } } },
      });
      return { family, ownerMember };
    }));
  } catch (error) {
    // Lost the race against a second concurrent `createFamily` call from the
    // same user (see RACE HANDLING above) — `FamilyMember.@@unique([userId])`
    // rejected this transaction's insert, rolling back its `Family` row too.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: ALREADY_IN_FAMILY_MESSAGE };
    }
    throw error;
  }

  return {
    success: true,
    data: {
      id: family.id,
      name: family.name,
      ownerId: family.ownerId,
      createdAt: family.createdAt,
      forceShareIndividualTransactions: family.forceShareIndividualTransactions,
      membersCanDeleteOwnTransactions: family.membersCanDeleteOwnTransactions,
      members: [
        {
          id: ownerMember.id,
          userId: ownerMember.userId,
          userName: ownerMember.user.name,
          role: ownerMember.role,
          joinedAt: ownerMember.joinedAt,
          shareIndividualTransactions: ownerMember.shareIndividualTransactions,
        },
      ],
    },
  };
}

/**
 * Server Action: the signed-in user's family, if any — the `/family` page's
 * single data source for deciding whether to show the "create a family"
 * form or the real family view (name + member list with roles).
 *
 * Contract:
 *  - Auth: requires a session; returns `{ success: false }` with a generic
 *    message if absent.
 *  - Not a member of any family: `{ success: true, data: null }` — this is
 *    NOT an error, it's the expected state for most users before Aşama 3.1
 *    is used for the first time.
 *  - Member of a family: `{ success: true, data }` where `data.members` is
 *    every `FamilyMember` row for that family (owner included), ordered by
 *    `joinedAt` ascending (owner first, since they're always the earliest
 *    row).
 *  - `db.familyMember.findFirst({ include: { family: true } })` and the
 *    follow-up `db.familyMember.findMany(...)` are both DIRECT top-level
 *    calls on `FamilyMember` — never `db.user.findUnique({ include:
 *    { familyMemberships: ... } })` or `db.family.findUnique({ include:
 *    { members: ... } })`, per CLAUDE.md. The nested `include: { family:
 *    true }` / `include: { user: { select: { name: true } } }` used here are
 *    safe under the soft-delete rule regardless — that rule only bans
 *    reaching `Transaction`/`Category` (the two models with a `deletedAt`
 *    column) via a nested include on `User`/`Family`/`FamilyMember`/
 *    `RecurringTransaction`. Neither `Family` nor `User` carries
 *    `deletedAt`, so there is no soft-delete filter to bypass here.
 */
export async function getMyFamily(): Promise<GetMyFamilyResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const membership = await db.familyMember.findFirst({
    where: { userId: session.user.id },
    include: { family: true },
  });

  if (!membership) {
    return { success: true, data: null };
  }

  const members = await db.familyMember.findMany({
    where: { familyId: membership.familyId },
    include: { user: { select: { name: true } } },
    orderBy: { joinedAt: "asc" },
  });

  return {
    success: true,
    data: {
      id: membership.family.id,
      name: membership.family.name,
      ownerId: membership.family.ownerId,
      createdAt: membership.family.createdAt,
      forceShareIndividualTransactions: membership.family.forceShareIndividualTransactions,
      membersCanDeleteOwnTransactions: membership.family.membersCanDeleteOwnTransactions,
      members: members.map((member) => ({
        id: member.id,
        userId: member.userId,
        userName: member.user.name,
        role: member.role,
        joinedAt: member.joinedAt,
        shareIndividualTransactions: member.shareIndividualTransactions,
      })),
    },
  };
}

export interface CreateInviteData {
  token: string;
  expiresAt: Date;
}

export type CreateInviteResult =
  | { success: true; data: CreateInviteData }
  | { success: false; error: string };

/**
 * Server Action: mints a shareable, link-based invite for the signed-in
 * user's family. There is no email-targeted delivery in this phase — the
 * caller is expected to build `/invite/${token}` client-side and share it
 * however they like (copy link, messaging app, etc.), hence `email: null`.
 *
 * Contract:
 *  - Auth: requires a session; generic message if absent.
 *  - Authorization: caller must be `OWNER` of a family (`assertIsFamilyOwner`
 *    — a direct `db.familyMember.findFirst` call, not a nested include).
 *    A member (non-owner) or someone in no family at all gets the same
 *    `NOT_OWNER_MESSAGE` — this endpoint never reveals whether the caller
 *    is a plain member vs. has no family, since neither case grants
 *    permission and the distinction isn't actionable for them here.
 *  - Token: `randomBytes(32).toString("base64url")` — 256 bits of CSPRNG
 *    entropy, NOT `randomUUID()` (UUIDv4 has ~122 bits of entropy and a
 *    fixed, guessable structure; a family-invite token is a bearer
 *    credential on its own, so it gets the stronger primitive). 32 raw
 *    bytes base64url-encode to a 43-character string.
 *  - Expiry: `expiresAt` = now + 7 days (`INVITE_EXPIRY_DAYS`), fixed by
 *    product decision, not caller-configurable.
 *  - Output: `CreateInviteResult`. On success, `data.token` is the RAW
 *    token (this is the only time it is ever returned in full — see
 *    `listActiveInvites`, which intentionally omits it). Frontend builds
 *    the shareable URL as `/invite/${data.token}`.
 *  - Not idempotent by design: every call mints a NEW invite row (multiple
 *    live invites for the same family are allowed, e.g. sharing separate
 *    links with separate people) — there is no "reuse an existing pending
 *    invite" behavior here.
 */
export async function createInvite(): Promise<CreateInviteResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const ownerCheck = await assertIsFamilyOwner(session.user.id);
  if (!ownerCheck.ok) {
    return { success: false, error: ownerCheck.error };
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const invite = await db.familyInvite.create({
    data: {
      familyId: ownerCheck.familyId,
      email: null,
      token,
      invitedBy: session.user.id,
      expiresAt,
    },
    select: { token: true, expiresAt: true },
  });

  return { success: true, data: { token: invite.token, expiresAt: invite.expiresAt } };
}

/**
 * A single row from the owner's "active invites" list — deliberately does
 * NOT include the raw `token`. Once minted, a token is only ever meant to
 * travel through the link the owner already shared; re-displaying it in a
 * management list would create a second place a bearer credential can leak
 * from (over-the-shoulder screen view, screenshot, etc.) for no product
 * benefit, since the owner already has the original share action to resend
 * if needed. `id` is enough for the "revoke" action to target this row.
 */
export interface FamilyInviteSummary {
  id: string;
  expiresAt: Date;
  createdAt: Date;
}

export type ListInvitesResult =
  | { success: true; data: FamilyInviteSummary[] }
  | { success: false; error: string };

/**
 * Server Action: the signed-in owner's currently-valid (not yet accepted,
 * not yet expired) invites for their family — the source for a "pending
 * invites" management list on `/family`.
 *
 * Contract:
 *  - Auth + authorization: same as `createInvite` (must be `OWNER`).
 *  - Filtering happens server-side, not just cosmetically: `acceptedAt:
 *    null` AND `expiresAt: { gt: new Date() }` are both applied in the
 *    `where` clause, so a consumed or expired invite never reaches the
 *    client at all (as opposed to being sent and hidden by the UI).
 *  - Ordered newest-first (`createdAt: "desc"`) so a freshly created invite
 *    appears at the top of the list.
 */
export async function listActiveInvites(): Promise<ListInvitesResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const ownerCheck = await assertIsFamilyOwner(session.user.id);
  if (!ownerCheck.ok) {
    return { success: false, error: ownerCheck.error };
  }

  const invites = await db.familyInvite.findMany({
    where: {
      familyId: ownerCheck.familyId,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, expiresAt: true, createdAt: true },
  });

  return { success: true, data: invites };
}

export type RevokeInviteResult = { success: true } | { success: false; error: string };

/**
 * Server Action: permanently deletes an invite belonging to the signed-in
 * owner's family (e.g. "I shared this with the wrong person, kill the
 * link"). `FamilyInvite` has no `deletedAt` column — it is NOT in the
 * soft-delete set (`Transaction`/`Category` only, per CLAUDE.md) — so a
 * real `db.familyInvite.delete(...)` is the correct operation here, not a
 * status flip.
 *
 * Does NOT check `acceptedAt` — an already-accepted invite can technically
 * be revoked too (a harmless no-op in practice: `listActiveInvites` never
 * surfaces an accepted invite's id to the UI, so a caller would have to
 * already know/guess one, and deleting an accepted `FamilyInvite` row
 * doesn't touch the `FamilyMember` row it produced).
 *
 * Contract:
 *  - Input: `inviteId: unknown`, validated as a cuid
 *    (`familyInviteIdSchema`) before use — same "don't trust the client
 *    type" reasoning as every other Server Action in this file.
 *  - Auth + authorization: caller must be `OWNER` of a family, AND the
 *    invite being revoked must belong to THAT SAME family (checked by
 *    comparing `invite.familyId` to the owner's `familyId`, not by trusting
 *    a `familyId` field from the caller) — an owner of family A can never
 *    revoke an invite belonging to family B, even if they guess/enumerate
 *    a valid invite id.
 *  - A malformed id, a nonexistent id, and an id belonging to a different
 *    family all return the same `INVITE_NOT_FOUND_MESSAGE` — this endpoint
 *    does not distinguish "doesn't exist" from "not yours" in its error
 *    message, so a caller can't use it to probe which invite ids exist.
 *  - Idempotent: revoking an already-revoked (or already-gone) id returns
 *    `{ success: true }`, not an error, mirroring
 *    `softDeleteTransaction`'s "double click must not surface as a
 *    failure" contract — the `P2025` ("record to delete does not exist")
 *    Prisma error is caught and treated as success rather than propagated.
 */
export async function revokeInvite(inviteId: unknown): Promise<RevokeInviteResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const idResult = familyInviteIdSchema.safeParse(inviteId);
  if (!idResult.success) {
    return { success: false, error: INVITE_NOT_FOUND_MESSAGE };
  }

  const ownerCheck = await assertIsFamilyOwner(session.user.id);
  if (!ownerCheck.ok) {
    return { success: false, error: ownerCheck.error };
  }

  const invite = await db.familyInvite.findUnique({
    where: { id: idResult.data },
    select: { id: true, familyId: true },
  });
  if (!invite || invite.familyId !== ownerCheck.familyId) {
    return { success: false, error: INVITE_NOT_FOUND_MESSAGE };
  }

  try {
    await db.familyInvite.delete({ where: { id: invite.id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      // Already deleted by a concurrent call (double click / retry) —
      // treat as a successful revoke, not a failure.
      return { success: true };
    }
    throw error;
  }

  return { success: true };
}

/**
 * Server Action: the signed-in user accepts a family invite by token,
 * joining as a `MEMBER`. Returns the same `FamilyActionResult` shape as
 * `createFamily`/`getMyFamily` so `/invite/[token]` can redirect to (or
 * directly render) `/family` without a separate follow-up fetch.
 *
 * Contract:
 *  - Input: `token: unknown`, validated as a non-empty, bounded-length
 *    string (`familyInviteTokenSchema`) — NOT a cuid, see that schema's
 *    comment for why.
 *  - Auth: requires a session; generic message if absent (an unauthenticated
 *    visitor hitting `/invite/[token]` should be sent to sign in/register
 *    first — that redirect is a frontend concern, not this action's).
 *  - Lookup: `db.familyInvite.findUnique({ where: { token } })`. A
 *    malformed token or one that doesn't exist both return
 *    `INVITE_NOT_FOUND_MESSAGE` — same "don't help enumerate" reasoning as
 *    `revokeInvite`.
 *  - Eligibility (`canAcceptInvite`, lib/domain/family/authorization.ts —
 *    pure, unit-testable independent of this file): checked with `now =
 *    new Date()` computed HERE (not inside the domain function) and the
 *    caller's current `FamilyMember` row (if any). Rejection reasons map
 *    to Turkish messages via `ACCEPT_INVITE_REJECTION_MESSAGES`.
 *  - Concurrency: the eligibility check above is a plain read, so two
 *    concurrent `acceptInvite` calls for the SAME token (double click, or
 *    an invite link opened by two different people) could both pass it.
 *    Closed with a database-level atomic guard rather than trusting the
 *    read: inside `$transaction`, `familyInvite.updateMany({ where: { id,
 *    acceptedAt: null }, ... })` only succeeds for whichever request gets
 *    there first (Postgres row-lock serializes the second behind it, which
 *    then sees `count: 0` once the first commits) — if this transaction
 *    doesn't "win" the claim, it aborts via `InviteAlreadyClaimedError` and
 *    the caller gets `already_accepted`. Separately, `FamilyMember` has a
 *    DB-level `@@unique([userId])` (schema.prisma) — if the SAME user
 *    somehow races two DIFFERENT invites (two tabs, two tokens) and wins
 *    both invite claims, the second `familyMember.create` hits that unique
 *    constraint (`P2002`), caught below and reported as `already_in_family`
 *    rather than crashing.
 *  - Output: `FamilyActionResult`, identical shape to `createFamily`'s
 *    success payload (freshly re-fetched member list, so the new member is
 *    included).
 */
export async function acceptInvite(token: unknown): Promise<FamilyActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsedToken = familyInviteTokenSchema.safeParse(token);
  if (!parsedToken.success) {
    return { success: false, error: INVITE_NOT_FOUND_MESSAGE };
  }

  const invite = await db.familyInvite.findUnique({
    where: { token: parsedToken.data },
  });
  if (!invite) {
    return { success: false, error: INVITE_NOT_FOUND_MESSAGE };
  }

  const now = new Date();
  const existingMembership = await db.familyMember.findFirst({
    where: { userId: session.user.id },
    select: { id: true },
  });

  const eligibility = canAcceptInvite(invite, existingMembership, now);
  if (!eligibility.ok) {
    return { success: false, error: ACCEPT_INVITE_REJECTION_MESSAGES[eligibility.reason] };
  }

  let familyId: string;
  try {
    const result = await db.$transaction(async (tx) => {
      const claim = await tx.familyInvite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: now },
      });
      if (claim.count === 0) {
        throw new InviteAlreadyClaimedError();
      }
      await tx.familyMember.create({
        data: { familyId: invite.familyId, userId: session.user.id, role: "MEMBER" },
      });
      return { familyId: invite.familyId };
    });
    familyId = result.familyId;
  } catch (error) {
    if (error instanceof InviteAlreadyClaimedError) {
      return { success: false, error: ACCEPT_INVITE_REJECTION_MESSAGES.already_accepted };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: ACCEPT_INVITE_REJECTION_MESSAGES.already_in_family };
    }
    throw error;
  }

  const [family, members] = await Promise.all([
    db.family.findUniqueOrThrow({ where: { id: familyId } }),
    db.familyMember.findMany({
      where: { familyId },
      include: { user: { select: { name: true } } },
      orderBy: { joinedAt: "asc" },
    }),
  ]);

  return {
    success: true,
    data: {
      id: family.id,
      name: family.name,
      ownerId: family.ownerId,
      createdAt: family.createdAt,
      forceShareIndividualTransactions: family.forceShareIndividualTransactions,
      membersCanDeleteOwnTransactions: family.membersCanDeleteOwnTransactions,
      members: members.map((member) => ({
        id: member.id,
        userId: member.userId,
        userName: member.user.name,
        role: member.role,
        joinedAt: member.joinedAt,
        shareIndividualTransactions: member.shareIndividualTransactions,
      })),
    },
  };
}

export type RemoveMemberResult = { success: true } | { success: false; error: string };

/**
 * Server Action (Aşama 3.4): the signed-in family owner removes another
 * member from their family. Hard `db.familyMember.delete` — `FamilyMember`
 * has no `deletedAt` column and is not in CLAUDE.md's soft-delete set, same
 * reasoning as `revokeInvite`'s delete of `FamilyInvite`.
 *
 * Contract:
 *  - Input: `memberId: unknown`, conceptually a `FamilyMember.id` — validated
 *    as a cuid (`familyMemberIdSchema`) before use, same "don't trust the
 *    client type" reasoning as every other Server Action in this file.
 *  - Auth + authorization: caller must be `OWNER` of a family
 *    (`assertIsFamilyOwner`, reused from `createInvite`/`revokeInvite`).
 *  - IDOR: the member row being removed must belong to THAT SAME family
 *    (`member.familyId === ownerCheck.familyId`, checked by re-fetching the
 *    row server-side, never by trusting a `familyId` from the caller). A
 *    malformed id, a nonexistent id, and an id belonging to a different
 *    family all return the same generic `MEMBER_NOT_FOUND_MESSAGE` — this
 *    endpoint never distinguishes "doesn't exist" from "not yours" in its
 *    error, so a caller can't use it to enumerate another family's member
 *    ids. Same pattern as `revokeInvite`.
 *  - Self-removal guard: an `OWNER` can never remove themselves through this
 *    action (`member.role === "OWNER"` — a family has exactly one `OWNER`
 *    row, so this is equivalent to `member.userId === session.user.id`).
 *    Rejected with `OWNER_CANNOT_REMOVE_SELF_MESSAGE`. Deliberately narrow:
 *    transferring ownership or deleting the family outright is out of scope
 *    for this phase.
 *  - Data integrity ("history doesn't break", roadmap Aşama 3.4 decision):
 *    this ONLY deletes the `FamilyMember` row. It never touches
 *    `Transaction` rows the removed member created — those keep their
 *    `familyId` set and remain visible to the rest of the family exactly as
 *    before. Access to them is already gated at read/mutate time by
 *    `assertOwnsTransaction` (lib/server/actions/transactions.ts), which
 *    looks up the acting user's CURRENT `FamilyMember` row for that
 *    `familyId` on every call — once this row is gone, the removed user's
 *    own subsequent attempts to touch those transactions are cut off
 *    automatically, with no extra step required here.
 *  - Idempotent: if the target row is already gone by the time the delete
 *    runs (double click / concurrent revoke), Prisma's `P2025` is caught and
 *    treated as `{ success: true }` rather than propagated — same contract
 *    as `revokeInvite`.
 */
export async function removeMember(memberId: unknown): Promise<RemoveMemberResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const idResult = familyMemberIdSchema.safeParse(memberId);
  if (!idResult.success) {
    return { success: false, error: MEMBER_NOT_FOUND_MESSAGE };
  }

  const ownerCheck = await assertIsFamilyOwner(session.user.id);
  if (!ownerCheck.ok) {
    return { success: false, error: ownerCheck.error };
  }

  const member = await db.familyMember.findUnique({
    where: { id: idResult.data },
    select: { id: true, familyId: true, role: true },
  });
  if (!member || member.familyId !== ownerCheck.familyId) {
    return { success: false, error: MEMBER_NOT_FOUND_MESSAGE };
  }

  if (member.role === "OWNER") {
    return { success: false, error: OWNER_CANNOT_REMOVE_SELF_MESSAGE };
  }

  try {
    await db.familyMember.delete({ where: { id: member.id } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      // Already removed by a concurrent call (double click / retry) — treat
      // as a successful removal, not a failure.
      return { success: true };
    }
    throw error;
  }

  return { success: true };
}

export type LeaveFamilyResult = { success: true } | { success: false; error: string };

/**
 * Server Action (Aşama 3.4): the signed-in user leaves the family they
 * currently belong to — works for both `MEMBER` and `OWNER` (see below for
 * how the two differ). Hard-deletes the caller's own `FamilyMember` row
 * (and, for an owner, possibly more — see below), same non-soft-delete
 * reasoning as `removeMember`.
 *
 * Contract:
 *  - Auth: requires a session; generic message if absent.
 *  - `session.user.id` is the ONLY source of "which membership row" —
 *    there is no id input to this action, so there is no IDOR surface to
 *    guard here (unlike `removeMember`, which targets another user's row).
 *  - Not a member of any family: `{ success: false, error:
 *    NOT_IN_FAMILY_MESSAGE }` — this is a real error for this action
 *    (nothing to leave), unlike `getMyFamily`'s `data: null` "no family yet"
 *    non-error case.
 *  - A plain `MEMBER` leaving: same as before — their own `FamilyMember`
 *    row is deleted, nothing else changes. Their past family `Transaction`
 *    rows keep their `familyId` untouched (same "history doesn't break"
 *    contract as `removeMember`), and `assertOwnsTransaction`'s live
 *    `FamilyMember` lookup cuts off their own further access to them
 *    automatically once this row is gone.
 *  - `OWNER` leaving — now allowed (previously blocked entirely), two cases:
 *     1. Other members exist: ownership transfers to the remaining member
 *        with the earliest `joinedAt` (`selectSuccessorOwner`,
 *        lib/domain/family/authorization.ts) — `Family.ownerId` and that
 *        member's `role` are updated to `OWNER`, then the leaving owner's
 *        `FamilyMember` row is deleted. Everyone else's access/data is
 *        untouched.
 *     2. No other members (the "İstisna durum 2" solo-owner case): the
 *        family is disbanded rather than left as an unreachable zero-member
 *        row forever taking up space. Before deleting `Family` itself, this
 *        clears two things that would otherwise break or leak:
 *          - Any pending `FamilyInvite`s are deleted first — otherwise a
 *            stale, un-revoked invite link could still be accepted after
 *            the family has no owner, creating a `FamilyMember` with no
 *            `OWNER` row to match it.
 *          - Any shared `Category` rows (`familyId` = this family) are
 *            reassigned to `familyId: null` rather than left to
 *            `Family`'s `ON DELETE CASCADE` on `Category` — a cascaded
 *            `Category` delete would collide with `Transaction.categoryId`'s
 *            `ON DELETE RESTRICT` (see prisma/schema.prisma) and fail the
 *            whole delete outright the moment any transaction had ever used
 *            that category. Nulling `familyId` instead quietly demotes the
 *            category to the (solo) owner's personal one — `userId` was
 *            always set to the creator regardless of `familyId`, so this is
 *            a no-op for how the category behaves afterward.
 *        `Transaction`/`RecurringTransaction`/`Budget` all use
 *        `ON DELETE SET NULL` on `familyId` already (schema-level), so no
 *        manual cleanup is needed for those — deleting `Family` just
 *        un-scopes them back to plain `userId`-owned rows, which for a solo
 *        owner's own history is the correct outcome (it reappears in their
 *        individual view instead of vanishing).
 *  - Idempotent: if the caller's row is already gone by the time the delete
 *    runs (double click / concurrent removal), `P2025` is caught and
 *    treated as `{ success: true }` — same contract as `revokeInvite` and
 *    `removeMember`.
 */
export async function leaveFamily(): Promise<LeaveFamilyResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const membership = await db.familyMember.findFirst({
    where: { userId: session.user.id },
    select: { id: true, role: true, familyId: true },
  });
  if (!membership) {
    return { success: false, error: NOT_IN_FAMILY_MESSAGE };
  }

  if (membership.role === "MEMBER") {
    try {
      await db.familyMember.delete({ where: { id: membership.id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        return { success: true };
      }
      throw error;
    }
    return { success: true };
  }

  // OWNER leaving from here down.
  const otherMembers = await db.familyMember.findMany({
    where: { familyId: membership.familyId, userId: { not: session.user.id } },
    orderBy: { joinedAt: "asc" },
    select: { id: true, userId: true, joinedAt: true },
  });

  const successor = selectSuccessorOwner(otherMembers);

  try {
    if (successor) {
      await db.$transaction([
        db.family.update({
          where: { id: membership.familyId },
          data: { ownerId: successor.userId },
        }),
        db.familyMember.update({
          where: { id: successor.id },
          data: { role: "OWNER" },
        }),
        db.familyMember.delete({ where: { id: membership.id } }),
      ]);
    } else {
      // Solo owner — disband the family. Order matters, see the doc
      // comment above: invites first, then un-scope shared categories,
      // then the family itself (which cascades the owner's own
      // `FamilyMember` row and, by now, zero remaining `FamilyInvite`s).
      await db.$transaction([
        db.familyInvite.deleteMany({ where: { familyId: membership.familyId } }),
        db.category.updateMany({
          where: { familyId: membership.familyId },
          data: { familyId: null },
        }),
        db.family.delete({ where: { id: membership.familyId } }),
      ]);
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      // The family/membership row was already gone by the time this ran
      // (e.g. a concurrent leave/removal race) — treat as a successful
      // leave, not a failure.
      return { success: true };
    }
    throw error;
  }

  return { success: true };
}

export type UpdateTransactionSharingResult =
  | { success: true; data: { shareIndividualTransactions: boolean } }
  | { success: false; error: string };

/**
 * Server Action: the signed-in user turns their own "bireysel işlemlerimi
 * aile ile paylaş" preference on/off — surfaced as a toggle under "Aile
 * Planı Ayarları". Each member controls only their OWN `FamilyMember` row;
 * there is no `memberId` input, so (like `leaveFamily`) there's no IDOR
 * surface here to guard.
 *
 * Contract:
 *  - Auth: requires a session; generic message if absent.
 *  - Not a member of any family: `{ success: false, error:
 *    NOT_IN_FAMILY_MESSAGE }` — nothing to toggle.
 *  - What flipping this ACTUALLY changes: only the default applied to
 *    individual (`familyId: null`) transactions this member creates FROM
 *    NOW ON — `createTransaction` (lib/server/actions/transactions.ts)
 *    reads this value at creation time and permanently stamps the new
 *    row's `sharedFamilyId` accordingly. It is NOT a live filter: turning
 *    this off does not hide transactions already stamped while it was on,
 *    and turning it on does not retroactively share ones created while it
 *    was off. `familyId` on the transaction itself is never touched either
 *    way, so ownership/mutation rights never move — sharing is read-only,
 *    forever tied to whoever created the row.
 *  - Owner lock: if the caller is a `MEMBER` (not the `OWNER`) AND their
 *    family's `Family.forceShareIndividualTransactions` is currently `true`
 *    (checked via a nested `select: { family: { select: {
 *    forceShareIndividualTransactions: true } } } }` on the SAME
 *    `db.familyMember.findFirst` call below — safe under CLAUDE.md's
 *    soft-delete rule, since `Family` has no `deletedAt` column, only
 *    `Transaction`/`Category` do), the update is rejected with
 *    `SHARING_LOCKED_BY_OWNER_MESSAGE` and NOTHING is written. The `OWNER`
 *    is exempt from their own lock — they can always change their own
 *    toggle regardless of `forceShareIndividualTransactions` (the switch
 *    only forces MEMBERS to be shared, it doesn't touch what the owner's
 *    own toggle does).
 *  - Output: `UpdateTransactionSharingResult`, echoing back the new value
 *    so the caller can update its UI without a follow-up `getMyFamily()`
 *    round-trip.
 */
export async function updateTransactionSharing(
  input: unknown
): Promise<UpdateTransactionSharingResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsed = shareIndividualTransactionsSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: VALIDATION_ERROR_MESSAGE };
  }

  const membership = await db.familyMember.findFirst({
    where: { userId: session.user.id },
    select: {
      id: true,
      role: true,
      family: { select: { forceShareIndividualTransactions: true } },
    },
  });
  if (!membership) {
    return { success: false, error: NOT_IN_FAMILY_MESSAGE };
  }

  if (membership.role !== "OWNER" && membership.family.forceShareIndividualTransactions) {
    return { success: false, error: SHARING_LOCKED_BY_OWNER_MESSAGE };
  }

  const updated = await db.familyMember.update({
    where: { id: membership.id },
    data: { shareIndividualTransactions: parsed.data },
    select: { shareIndividualTransactions: true },
  });

  return {
    success: true,
    data: { shareIndividualTransactions: updated.shareIndividualTransactions },
  };
}

export type UpdateForceShareIndividualTransactionsResult =
  | { success: true; data: { forceShareIndividualTransactions: boolean } }
  | { success: false; error: string };

/**
 * Server Action: the signed-in family OWNER turns the family-wide "diğer
 * üyelere paylaşma tercihini yasakla ve bireysel işlemlerini zorunlu paylaş"
 * kill switch on/off — surfaced under "Aile Planı Ayarları", owner-only.
 * There is no `familyId` input (like `createInvite`/`listActiveInvites`):
 * the target family is always derived from the caller's OWN ownership via
 * `assertIsFamilyOwner`, never from client-supplied data, so there is no
 * IDOR surface here either.
 *
 * Contract (relied on by frontend-developer / mobile-developer):
 *  - Input: `unknown`, conceptually a bare boolean — re-validated here with
 *    `forceShareIndividualTransactionsSchema`, same "don't trust the client
 *    type" reasoning as every other Server Action in this file.
 *  - Auth: requires a session; generic message if absent.
 *  - Authorization: caller must be `OWNER` of a family (`assertIsFamilyOwner`
 *    — a direct `db.familyMember.findFirst` call). A `MEMBER`, or someone in
 *    no family at all, gets `NOT_OWNER_MESSAGE` and nothing is written —
 *    this is the ONE control a member can never flip for themselves, by
 *    design (the whole point of the feature).
 *  - What flipping this ACTUALLY changes, immediately (unlike
 *    `updateTransactionSharing`, which only affects transactions created
 *    FROM NOW ON): turning it on (a) locks every MEMBER's own
 *    `shareIndividualTransactions` toggle going forward (see
 *    `updateTransactionSharing`'s new rejection branch above) and (b) widens
 *    every family-wide READ (`lib/server/actions/family-transactions.ts`) to
 *    also include every CURRENT member's individual (`familyId: null`)
 *    transactions, regardless of each member's own toggle value or of what
 *    `sharedFamilyId` was stamped on each row at creation time. This is a
 *    READ-TIME override only — no `Transaction` row is mutated by this call,
 *    and turning the switch back off simply stops widening the read again
 *    (nothing to roll back). See `getFamilySharingWindow` in
 *    family-transactions.ts for where this is read.
 *  - Output: `UpdateForceShareIndividualTransactionsResult`, echoing back the
 *    new value so the caller can update its UI without a follow-up
 *    `getMyFamily()` round-trip.
 */
export async function updateForceShareIndividualTransactions(
  input: unknown
): Promise<UpdateForceShareIndividualTransactionsResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsed = forceShareIndividualTransactionsSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: VALIDATION_ERROR_MESSAGE };
  }

  const ownerCheck = await assertIsFamilyOwner(session.user.id);
  if (!ownerCheck.ok) {
    return { success: false, error: ownerCheck.error };
  }

  const updated = await db.family.update({
    where: { id: ownerCheck.familyId },
    data: { forceShareIndividualTransactions: parsed.data },
    select: { forceShareIndividualTransactions: true },
  });

  return {
    success: true,
    data: { forceShareIndividualTransactions: updated.forceShareIndividualTransactions },
  };
}

export type UpdateMembersCanDeleteOwnTransactionsResult =
  | { success: true; data: { membersCanDeleteOwnTransactions: boolean } }
  | { success: false; error: string };

/**
 * Server Action: the signed-in family OWNER turns on/off whether MEMBERs may
 * delete REAL family transactions (`Transaction.familyId` set) that THEY
 * THEMSELVES created — surfaced under "Aile Planı Ayarları", owner-only.
 * Same "no `familyId` input, no IDOR surface" shape as
 * `updateForceShareIndividualTransactions` — the target family is always
 * derived from the caller's OWN ownership via `assertIsFamilyOwner`, never
 * from client-supplied data.
 *
 * Contract (relied on by frontend-developer / mobile-developer):
 *  - Input: `unknown`, conceptually a bare boolean — re-validated here with
 *    `membersCanDeleteOwnTransactionsSchema`, same "don't trust the client
 *    type" reasoning as every other Server Action in this file.
 *  - Auth: requires a session; generic message if absent.
 *  - Authorization: caller must be `OWNER` of a family (`assertIsFamilyOwner`
 *    — a direct `db.familyMember.findFirst` call). A `MEMBER`, or someone in
 *    no family at all, gets `NOT_OWNER_MESSAGE` and nothing is written.
 *  - What flipping this ACTUALLY changes: read by
 *    `assertCanDeleteTransaction` (lib/server/actions/transactions.ts) on
 *    EVERY delete attempt against a real family transaction — there is no
 *    caching/snapshotting involved, so flipping it takes effect immediately
 *    for any delete attempted afterward. It does NOT retroactively do
 *    anything to existing rows (nothing to "undo" either way) and it never
 *    changes the OWNER's own delete rights (always full, regardless of this
 *    toggle) or the unrelated `sharedFamilyId` delete path (still creator-or-
 *    owner, unaffected by this flag). See `canDeleteTransaction`
 *    (lib/domain/transactions/authorization.ts) for the exact rule.
 *  - Output: `UpdateMembersCanDeleteOwnTransactionsResult`, echoing back the
 *    new value so the caller can update its UI without a follow-up
 *    `getMyFamily()` round-trip.
 */
export async function updateMembersCanDeleteOwnTransactions(
  input: unknown
): Promise<UpdateMembersCanDeleteOwnTransactionsResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: UNAUTHENTICATED_MESSAGE };
  }

  const parsed = membersCanDeleteOwnTransactionsSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: VALIDATION_ERROR_MESSAGE };
  }

  const ownerCheck = await assertIsFamilyOwner(session.user.id);
  if (!ownerCheck.ok) {
    return { success: false, error: ownerCheck.error };
  }

  const updated = await db.family.update({
    where: { id: ownerCheck.familyId },
    data: { membersCanDeleteOwnTransactions: parsed.data },
    select: { membersCanDeleteOwnTransactions: true },
  });

  return {
    success: true,
    data: { membersCanDeleteOwnTransactions: updated.membersCanDeleteOwnTransactions },
  };
}
