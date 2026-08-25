import { z } from "zod";
import { Currency } from "@prisma/client";

// Same amount-validation shape as lib/validation/transaction.ts's
// `amountSchema` (accepts number or string, resolves to a string with at
// most 2 decimal places, positive, capped) — duplicated rather than imported
// because that schema is module-private there; kept identical deliberately
// so a limit amount and a transaction amount are validated by the exact same
// rules (CLAUDE.md: money is always Decimal, never Float, everywhere).
const MAX_AMOUNT = 999_999_999.99;

// Every `error:` value in this file is a STABLE KEY (`validation.budget.*`),
// not display text — see lib/validation/transaction.ts's "i18n note" for the
// same discipline applied there. `MAX_AMOUNT`'s value is baked as static
// text into `validation.budget.limitAmountMax`'s translation, not
// interpolated at parse time — update both locale files if the constant
// ever changes.
const limitAmountSchema = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === "number" ? value.toString() : value.trim()))
  .pipe(
    z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, {
      error: "validation.budget.amountFormat",
    })
  )
  .refine((value) => Number(value) > 0, { error: "validation.budget.limitAmountPositive" })
  .refine((value) => Number(value) <= MAX_AMOUNT, {
    error: "validation.budget.limitAmountMax",
  });

/**
 * `categoryId` format is validated as a cuid here (same reasoning as
 * lib/validation/transaction.ts's `categoryIdSchema`) — whether it actually
 * points at a category the caller is allowed to use is an
 * authorization/existence question checked against the database in
 * lib/server/actions/budgets.ts, not a shape question here.
 */
const categoryIdSchema = z.cuid({ error: "validation.budget.categoryRequired" });

// No `period` field: `BudgetPeriod` (schema.prisma) currently has only one
// value (`MONTHLY`) — nothing for the caller to choose, so it isn't part of
// the input shape at all. The server always sets `period: "MONTHLY"`
// explicitly when writing to the DB. If a second period value is ever added,
// this schema gains a `period` field then, not before.
export const budgetSchema = z.object({
  categoryId: categoryIdSchema,
  limitAmount: limitAmountSchema,
  currency: z.enum(Currency, { error: "validation.budget.currencyInvalid" }),
});

export type BudgetInput = z.infer<typeof budgetSchema>;

/** Partial version for updates — `limitAmount`/`currency` only (no
 * `categoryId`: re-attributing an existing budget to a different category is
 * not supported via update, same "fixed at creation" discipline as
 * `transactionUpdateSchema` omitting `familyId`). */
export const budgetUpdateSchema = budgetSchema.omit({ categoryId: true }).partial();
export type BudgetUpdateInput = z.infer<typeof budgetUpdateSchema>;

/** Validates a budget id parameter (e.g. for update/delete calls). */
export const budgetIdSchema = z.cuid({ error: "validation.budget.idInvalid" });
