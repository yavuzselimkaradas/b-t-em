// Framework-agnostic domain logic for budgets (limit checks, period math,
// spend-vs-limit calculations). No Next.js / Prisma imports — shared between
// web and mobile.
export * from "./evaluate";
