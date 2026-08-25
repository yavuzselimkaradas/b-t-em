// Phase 1 seed: a single known test user, so backend/frontend work has
// something to log in as before family (owner+member) seeding is added in
// Phase 3. Run with `npm run db:seed` or `npx prisma db seed`.
//
// Phase 2 addition: default (global) categories + sample transactions for
// the test user, so Transaction CRUD (and, later, the Phase 5
// dashboard/charts) has real data to exercise without needing Category CRUD
// (Phase 4) to exist first. See CLAUDE.md for the Phase 2 scoping decision.
//
// Deliberately creates its own PrismaClient instead of importing the app's
// singleton from src/lib/server/db.ts — that module imports "server-only",
// which throws unconditionally outside of Next.js's bundler and would break
// this script when run directly via `tsx`. This also means the soft-delete
// read extension is NOT applied to any query in this file — fine here since
// nothing in this script ever soft-deletes anything.
import "dotenv/config";
import { PrismaClient, TransactionType, Currency, type PrismaClient as PrismaClientType } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

const BCRYPT_COST_FACTOR = 12;
const TEST_USER_EMAIL = "test@butcem.app";
// Known dev/test credential — never reuse this pattern for real user data.
const TEST_USER_PASSWORD = "Test1234!";

// Default categories every user can use immediately, with no Category CRUD
// (Phase 4) needed yet. `isDefault: true`, `userId`/`familyId` both null —
// exactly the "usable by anyone" shape `assertUsableCategory` in
// lib/server/actions/transactions.ts checks for.
const DEFAULT_CATEGORIES: { name: string; type: TransactionType }[] = [
  { name: "Maaş", type: TransactionType.INCOME },
  { name: "Diğer Gelir", type: TransactionType.INCOME },
  { name: "Market", type: TransactionType.EXPENSE },
  { name: "Kira", type: TransactionType.EXPENSE },
  { name: "Ulaşım", type: TransactionType.EXPENSE },
  { name: "Eğlence", type: TransactionType.EXPENSE },
  { name: "Diğer Gider", type: TransactionType.EXPENSE },
];

// Sample transactions for the test user, expressed as "days before the
// moment the seed script runs" rather than fixed calendar dates — so the
// data stays "recent" (spans ~3 months back from whenever this is run) no
// matter when someone re-seeds. 22 rows, mixing both types and all 7
// categories, useful for Phase 2 CRUD screens and Phase 5's dashboard/charts
// alike.
const SAMPLE_TRANSACTIONS: {
  daysAgo: number;
  type: TransactionType;
  category: string;
  amount: string;
  description: string;
}[] = [
  { daysAgo: 88, type: TransactionType.INCOME, category: "Maaş", amount: "32000.00", description: "Maaş ödemesi" },
  { daysAgo: 86, type: TransactionType.EXPENSE, category: "Kira", amount: "9500.00", description: "Ev kirası" },
  { daysAgo: 83, type: TransactionType.EXPENSE, category: "Market", amount: "650.75", description: "Haftalık market alışverişi" },
  { daysAgo: 80, type: TransactionType.EXPENSE, category: "Ulaşım", amount: "300.00", description: "Akbil yükleme" },
  { daysAgo: 76, type: TransactionType.EXPENSE, category: "Eğlence", amount: "450.00", description: "Sinema" },
  { daysAgo: 70, type: TransactionType.EXPENSE, category: "Market", amount: "580.20", description: "Market alışverişi" },
  { daysAgo: 65, type: TransactionType.INCOME, category: "Diğer Gelir", amount: "1200.00", description: "Freelance iş" },
  { daysAgo: 60, type: TransactionType.EXPENSE, category: "Diğer Gider", amount: "250.00", description: "Kırtasiye" },
  { daysAgo: 58, type: TransactionType.INCOME, category: "Maaş", amount: "32000.00", description: "Maaş ödemesi" },
  { daysAgo: 56, type: TransactionType.EXPENSE, category: "Kira", amount: "9500.00", description: "Ev kirası" },
  { daysAgo: 52, type: TransactionType.EXPENSE, category: "Market", amount: "720.40", description: "Market alışverişi" },
  { daysAgo: 48, type: TransactionType.EXPENSE, category: "Ulaşım", amount: "280.00", description: "Yakıt" },
  { daysAgo: 40, type: TransactionType.EXPENSE, category: "Eğlence", amount: "600.00", description: "Konser bileti" },
  { daysAgo: 35, type: TransactionType.EXPENSE, category: "Market", amount: "495.10", description: "Market alışverişi" },
  { daysAgo: 30, type: TransactionType.INCOME, category: "Maaş", amount: "32000.00", description: "Maaş ödemesi" },
  { daysAgo: 28, type: TransactionType.EXPENSE, category: "Kira", amount: "9500.00", description: "Ev kirası" },
  { daysAgo: 24, type: TransactionType.EXPENSE, category: "Market", amount: "610.00", description: "Market alışverişi" },
  { daysAgo: 20, type: TransactionType.EXPENSE, category: "Ulaşım", amount: "300.00", description: "Akbil yükleme" },
  { daysAgo: 15, type: TransactionType.EXPENSE, category: "Eğlence", amount: "350.00", description: "Akşam yemeği" },
  { daysAgo: 10, type: TransactionType.EXPENSE, category: "Diğer Gider", amount: "180.00", description: "Kişisel bakım" },
  { daysAgo: 5, type: TransactionType.EXPENSE, category: "Market", amount: "540.60", description: "Market alışverişi" },
  { daysAgo: 1, type: TransactionType.EXPENSE, category: "Ulaşım", amount: "120.00", description: "Taksi" },
];

/**
 * Idempotent "ensure this default category exists" helper. There is no
 * unique DB constraint on (name, type, isDefault) that `upsert` could key
 * off — Category's only unique field is `id` — so this does a manual
 * find-then-create instead. Safe to call repeatedly: re-running the seed
 * never creates duplicate default categories.
 */
async function ensureDefaultCategory(prisma: PrismaClientType, name: string, type: TransactionType) {
  const existing = await prisma.category.findFirst({
    where: { name, type, isDefault: true, userId: null, familyId: null },
  });
  if (existing) return existing;

  return prisma.category.create({
    data: { name, type, isDefault: true, userId: null, familyId: null },
  });
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill in your Postgres connection string before seeding."
    );
  }

  const adapter = new PrismaPg(connectionString);
  const prisma = new PrismaClient({ adapter });

  try {
    const passwordHash = await bcrypt.hash(TEST_USER_PASSWORD, BCRYPT_COST_FACTOR);

    // upsert keeps this idempotent: re-running the seed after the user
    // already exists won't error and won't reset their data.
    const user = await prisma.user.upsert({
      where: { email: TEST_USER_EMAIL },
      update: {},
      create: {
        name: "Test Kullanıcı",
        email: TEST_USER_EMAIL,
        passwordHash,
      },
    });

    console.log(`Seed OK — test user ready: ${user.email} (id: ${user.id})`);
    console.log(`Login with: ${TEST_USER_EMAIL} / ${TEST_USER_PASSWORD}`);

    const categoriesByName = new Map<string, { id: string }>();
    for (const definition of DEFAULT_CATEGORIES) {
      const category = await ensureDefaultCategory(prisma, definition.name, definition.type);
      categoriesByName.set(definition.name, category);
    }
    console.log(`Seed OK — ${categoriesByName.size} default categories ready.`);

    // Only seed sample transactions the FIRST time — if the test user
    // already has any (e.g. from a previous seed run, or from manually
    // testing the app), re-seeding must not pile on duplicates or touch
    // real data, mirroring the user upsert's "don't reset existing data"
    // guarantee above.
    const existingTransactionCount = await prisma.transaction.count({
      where: { userId: user.id },
    });

    if (existingTransactionCount > 0) {
      console.log(
        `Skipping sample transactions — ${TEST_USER_EMAIL} already has ${existingTransactionCount}.`
      );
    } else {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;

      for (const sample of SAMPLE_TRANSACTIONS) {
        const category = categoriesByName.get(sample.category);
        if (!category) {
          throw new Error(`Seed bug: unknown category "${sample.category}" in SAMPLE_TRANSACTIONS.`);
        }

        await prisma.transaction.create({
          data: {
            userId: user.id,
            createdById: user.id,
            familyId: null,
            type: sample.type,
            amount: sample.amount,
            currency: Currency.TRY,
            categoryId: category.id,
            description: sample.description,
            date: new Date(now - sample.daysAgo * dayMs),
          },
        });
      }

      console.log(`Seed OK — ${SAMPLE_TRANSACTIONS.length} sample transactions created.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
