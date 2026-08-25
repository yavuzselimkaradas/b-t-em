// Prisma 7 config file — replaces the schema-embedded `datasource { url }` from older
// Prisma versions. This file is read by the Prisma CLI only (validate, generate, migrate,
// db seed, studio) — it is NOT used by the app at runtime.
//
// `datasource.url` intentionally points at DIRECT_URL (the non-pooled Neon connection),
// because schema migrations run DDL and should not go through a pgBouncer-style pooler.
// The app's runtime Prisma Client (src/lib/server/db.ts) uses a driver adapter constructed
// from the pooled DATABASE_URL instead — see that file and prisma/README.md for details.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
