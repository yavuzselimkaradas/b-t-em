-- Kullanıcı başına tek aile kararını (Aile Planı roadmap'i) DB seviyesinde
-- garanti eder: bir userId, FamilyMember tablosunda en fazla bir satırda
-- geçebilir (hangi aile/rol olursa olsun).
DROP INDEX IF EXISTS "FamilyMember_userId_idx";
ALTER TABLE "FamilyMember" ADD CONSTRAINT "FamilyMember_userId_key" UNIQUE ("userId");
