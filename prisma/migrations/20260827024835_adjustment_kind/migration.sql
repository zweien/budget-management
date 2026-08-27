-- CreateEnum
CREATE TYPE "AdjustmentKind" AS ENUM ('ADJUST', 'ALLOCATE');

-- AlterTable
ALTER TABLE "budget_adjustments" ADD COLUMN     "kind" "AdjustmentKind" NOT NULL DEFAULT 'ADJUST';
