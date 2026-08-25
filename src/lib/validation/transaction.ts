import { z } from "zod";
import { Currency, TransactionType } from "@prisma/client";

// ── Bounds, chosen deliberately (see CLAUDE.md "Genel kurallar": amounts are
//    always Decimal, never Float) ───────────────────────────────────────────
//
// - amount: the DB column is Decimal(14, 2) (12 integer digits + 2 fraction
//   digits), but we cap far below that ceiling at 999,999,999.99 (9 integer
//   digits) as a sane product-level limit — no household transaction should
//   realistically exceed it, and this still leaves headroom in the DB column
//   itself for a future currency/scale change without a migration.
// - date: no lower bound (a user may want to backfill years of history).
//   Product decision: no future-dated income/expense at all — a transaction
//   is a record of something that happened, not a plan. The cap isn't a
//   literal `Date.now()` though: `dateSchema` is fed a date-ONLY string
//   (e.g. "2026-08-12"), which `z.coerce.date()` parses as UTC midnight —
//   so a user in a timezone AHEAD of UTC (e.g. Turkey, UTC+3) picking their
//   own local "today" in the first few hours after local midnight would
//   produce a UTC timestamp that's technically still ahead of the server's
//   `Date.now()`. One day of slack absorbs that skew (comfortably covers
//   every real-world UTC+ timezone) without meaningfully allowing "future"
//   entries in the product sense — nobody can backdate a transaction to
//   next week, next month, or next year.
const MAX_AMOUNT = 999_999_999.99;
const MAX_FUTURE_DAYS = 1;
const MAX_DESCRIPTION_LENGTH = 500;

/**
 * Accepts either a `number` (an already-parsed numeric form value) or a
 * `string` (a raw text input), but always resolves to a STRING with at most
 * 2 decimal places — never a `number` — so callers can hand it straight to
 * Prisma's `Decimal` column without ever routing the value through
 * floating-point arithmetic. Prisma's Decimal fields accept a string
 * directly in `create`/`update` calls, so no further conversion is needed.
 */
// ── i18n note ────────────────────────────────────────────────────────────
// Every `error:` value below is a STABLE KEY (`validation.transaction.*`),
// not display text — this module is imported by both server code and
// `lib/client/guest-store.ts` (client-side), and neither imports next-intl
// here. The actual Turkish/English copy — including any value that used to
// be interpolated at parse-time (e.g. `MAX_AMOUNT`, `MAX_DESCRIPTION_LENGTH`)
// — now lives baked into `messages/{locale}.json`'s `validation.transaction`
// namespace as static text, since these constants are fixed at build time,
// not runtime/per-caller. If either constant's VALUE ever changes, update
// the corresponding message strings in both locale files to match.
const amountSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === "number" ? value.toString() : value.trim()))
  .pipe(
    z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, {
      error: "validation.transaction.amountFormat",
    })
  )
  .refine((value) => Number(value) > 0, { error: "validation.transaction.amountPositive" })
  .refine((value) => Number(value) <= MAX_AMOUNT, {
    error: "validation.transaction.amountMax",
  });

// `.refine()` (not `.max(new Date(...))`) so the upper bound is computed at
// PARSE time, not at module-load time — this module is imported once and
// reused across requests in a long-lived server process, and a Date literal
// baked in at import time would slowly go stale.
const dateSchema = z.coerce
  .date({ error: "validation.transaction.dateInvalid" })
  .refine((value) => value.getTime() <= Date.now() + MAX_FUTURE_DAYS * 24 * 60 * 60 * 1000, {
    error: "validation.transaction.dateNotFuture",
  });

const descriptionSchema = z
  .string()
  .trim()
  .max(MAX_DESCRIPTION_LENGTH, {
    error: "validation.transaction.descriptionMax",
  })
  .optional()
  .transform((value) => (value === "" ? undefined : value));

/**
 * `categoryId` format is validated as a cuid here (Prisma's `@default(cuid())`
 * id generator) as cheap defense-in-depth — whether the id actually points
 * at a category the caller is allowed to use is a data-existence /
 * authorization question, not a shape question, and is checked separately
 * in `lib/server/actions/transactions.ts` against the database.
 */
const categoryIdSchema = z.cuid({ error: "validation.transaction.categoryRequired" });

// Aşama 3.3: optional, cuid-shaped like `categoryIdSchema` — whether the
// caller is actually a member of this family (and thus may attach a
// transaction to it) is an authorization/existence question checked against
// the database in lib/server/actions/transactions.ts, not a shape question
// here. Omitted entirely (not `null`) means an individual transaction, same
// as every existing row created before this field existed.
const familyIdSchema = z.cuid({ error: "validation.transaction.familyInvalid" }).optional();

export const transactionSchema = z.object({
  type: z.enum(TransactionType, { error: "validation.transaction.typeInvalid" }),
  amount: amountSchema,
  currency: z.enum(Currency, { error: "validation.transaction.currencyInvalid" }),
  categoryId: categoryIdSchema,
  description: descriptionSchema,
  date: dateSchema,
  familyId: familyIdSchema,
});

export type TransactionInput = z.infer<typeof transactionSchema>;

/**
 * Partial version for updates — every field optional, but any field that IS
 * supplied must still satisfy the same rules as create. Zod omits keys the
 * caller didn't send from `.parse()`'s output entirely (rather than setting
 * them to `undefined`), so `{ ...parsed.data }` spread into a Prisma
 * `update({ data: ... })` naturally only touches the fields the caller
 * actually sent — PATCH semantics, without any extra bookkeeping here.
 *
 * `.omit({ familyId: true })` — Aşama 3.3 deliberately does NOT support
 * re-attributing an existing transaction between individual/family (or
 * between two families) via update; only `createTransaction` accepts
 * `familyId`, fixed at creation. Without this omission, `.partial()` would
 * inherit `familyId` from `transactionSchema` and let a caller move a
 * transaction into an arbitrary family by id — `updateTransaction`'s
 * ownership check (`assertOwnsTransaction`) authorizes mutating the EXISTING
 * row's family, not whatever family a payload might try to switch it to, so
 * that input must not even reach the database layer.
 */
export const transactionUpdateSchema = transactionSchema.omit({ familyId: true }).partial();
export type TransactionUpdateInput = z.infer<typeof transactionUpdateSchema>;

/** Validates a transaction id parameter (e.g. for update/delete calls). */
export const transactionIdSchema = z.cuid({ error: "validation.transaction.idInvalid" });

// Same slack/reasoning as `dateSchema` above — a UI-picked "today" must
// never be rejected, but no genuinely future period (next month, next
// year — e.g. "Mayıs 2027") is filterable, matching the product decision
// that future-dated transactions don't exist so a future filter range is
// never meaningful, only ever empty or confusing.
const notFutureDateSchema = (message: string) =>
  z.coerce
    .date({ error: message })
    .refine((value) => value.getTime() <= Date.now() + MAX_FUTURE_DAYS * 24 * 60 * 60 * 1000, {
      error: "validation.transaction.filterDateNotFuture",
    });

export const transactionFiltersSchema = z
  .object({
    from: notFutureDateSchema("validation.transaction.fromDateInvalid").optional(),
    to: notFutureDateSchema("validation.transaction.toDateInvalid").optional(),
    categoryId: categoryIdSchema.optional(),
    type: z.enum(TransactionType, { error: "validation.transaction.typeInvalid" }).optional(),
    // NOT a WHERE-clause narrowing field like the others above — doesn't
    // change which rows match, only which currency `summarize()`
    // (lib/domain/transactions/aggregate.ts) treats as "always present,
    // sorts first" when it folds grouped rows into a `PerCurrencyTotal[]`.
    // Bundled into the same filters object purely so `summarizeTransactions`/
    // `summarizeFamilyTransactions`/`summarizeGuestTransactions` — and every
    // UI caller already passing a `filters: unknown` bag to them
    // (`NetTotalCard`, `YearPickerPanel`) — don't need a second parameter
    // threaded through their whole call chain. Trusting a client-supplied
    // value here carries no authorization risk: it only affects display
    // ORDER/labeling of totals the user is already allowed to see, never
    // which rows are summed. Optional/omittable — every action defaults it
    // to `"TRY"` when absent, preserving old behavior for any caller that
    // doesn't know about this field yet.
    baseCurrency: z.enum(Currency).optional(),
    page: z.coerce
      .number({ error: "validation.transaction.pageInvalid" })
      .int()
      .min(1, { error: "validation.transaction.pageMin" })
      .max(100_000, { error: "validation.transaction.pageMax" })
      .default(1),
  })
  .refine((data) => !data.from || !data.to || data.from <= data.to, {
    error: "validation.transaction.dateRangeInvalid",
    path: ["from"],
  });

export type TransactionFilters = z.infer<typeof transactionFiltersSchema>;
