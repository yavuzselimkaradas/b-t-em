// Framework-agnostic domain logic for the family plan (membership rules,
// owner/member authorization). No Next.js / Prisma imports here — this
// module is shared between the web app (src/lib/server) and the future
// mobile client.
export * from "./authorization";
