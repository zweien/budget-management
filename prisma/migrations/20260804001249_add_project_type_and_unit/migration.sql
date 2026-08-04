-- AlterTable
ALTER TABLE "budget_adjustment_lines" ALTER COLUMN "total_adjustment" DROP DEFAULT,
ALTER COLUMN "annual_adjustment" DROP DEFAULT;

-- AlterTable
ALTER TABLE "budget_adjustments" ALTER COLUMN "year" DROP DEFAULT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "project_type" TEXT,
ADD COLUMN     "undertaking_unit" TEXT;
