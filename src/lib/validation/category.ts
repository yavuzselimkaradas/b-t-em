import { z } from "zod";
import { TransactionType } from "@prisma/client";

// `TransactionType` is a value import from `@prisma/client` here (not just a
// type), same as lib/validation/transaction.ts — safe to bundle client-side
// despite that package normally being server-only: Prisma's generated enum
// is a plain object of string literals, unlike `PrismaClient` itself (which
// carries the "server-only" guard in lib/server/db.ts). This file is
// imported by lib/client/guest-store.ts, so it must stay that way.
const MAX_NAME_LENGTH = 50;

// Every `error:` value below is a STABLE KEY (`validation.category.*`), not
// display text — see lib/validation/transaction.ts's "i18n note" for the
// same discipline applied there. `MAX_NAME_LENGTH`'s value is baked as
// static text into `validation.category.nameMax`'s translation, not
// interpolated at parse time — update both locale files if it ever changes.
export const categorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "validation.category.nameRequired" })
    .max(MAX_NAME_LENGTH, { error: "validation.category.nameMax" }),
  type: z.enum(TransactionType, { error: "validation.category.typeInvalid" }),
});

export type CategoryInput = z.infer<typeof categorySchema>;
