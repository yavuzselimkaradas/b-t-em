// Framework-agnostic domain logic for transactions (income/expense entries).
// No Next.js / Prisma imports here — this module is shared between the web
// app (src/lib/server) and the future mobile client.
export * from "./aggregate";
export * from "./authorization";
