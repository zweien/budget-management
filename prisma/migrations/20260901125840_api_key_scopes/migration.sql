-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "projectIds" JSONB,
ADD COLUMN     "project_scope" TEXT NOT NULL DEFAULT 'all',
ADD COLUMN     "tier" TEXT NOT NULL DEFAULT 'full';
