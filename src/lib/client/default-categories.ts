// Client-side mirror of prisma/seed.ts's `DEFAULT_CATEGORIES` — the same
// names/types every signed-in user gets seeded, copied here as a constant so
// guest mode (src/lib/client/guest-store.ts) never needs a DB round-trip to
// populate a category dropdown. If the seed list ever changes, update both
// — there is no single source of truth across a DB table and a client
// constant, and that's an accepted tradeoff for guest mode staying 100%
// client-side (see CLAUDE.md "Misafir modu").
//
// Ids are fixed, human-legible strings, but shaped to satisfy Zod's
// `z.cuid()` (`/^[cC][0-9a-z]{6,}$/`, used by `categoryIdSchema` in
// lib/validation/transaction.ts) — guest mode re-validates transaction
// input with the EXACT SAME schema as the server (see guest-store.ts), so a
// category id that doesn't look like a cuid would fail that shared
// validation. "guest-salary" (a hyphen, doesn't start with c) would fail;
// "cguestmaas" passes.
// `TransactionType` imported as a TYPE only, deliberately — this module is
// bundled for the browser (used with no session at all), and `@prisma/client`
// is otherwise a server-only package (see the "server-only" guard in
// lib/server/db.ts); a value import of its generated enum would risk pulling
// server-oriented code into the client bundle. Plain string literals
// ("INCOME"/"EXPENSE") are the enum's actual runtime values, so this stays
// type-safe without importing anything at runtime.
import type { Category, TransactionType } from "@prisma/client";

const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

const NAMES_AND_TYPES: { id: string; name: string; type: TransactionType }[] = [
  { id: "cguestmaas", name: "Maaş", type: "INCOME" },
  { id: "cguestdigergelir", name: "Diğer Gelir", type: "INCOME" },
  { id: "cguestmarket", name: "Market", type: "EXPENSE" },
  { id: "cguestkira", name: "Kira", type: "EXPENSE" },
  { id: "cguestulasim", name: "Ulaşım", type: "EXPENSE" },
  { id: "cguesteglence", name: "Eğlence", type: "EXPENSE" },
  { id: "cguestdigergider", name: "Diğer Gider", type: "EXPENSE" },
];

export const DEFAULT_CATEGORIES: Category[] = NAMES_AND_TYPES.map((c) => ({
  ...c,
  isDefault: true,
  icon: null,
  color: null,
  userId: null,
  familyId: null,
  createdAt: CREATED_AT,
  deletedAt: null,
}));

export function findDefaultCategory(categoryId: string): Category | undefined {
  return DEFAULT_CATEGORIES.find((category) => category.id === categoryId);
}
