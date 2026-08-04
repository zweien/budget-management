-- DropForeignKey
ALTER TABLE "budget_adjustment_lines" DROP CONSTRAINT "budget_adjustment_lines_subject_id_fkey";

-- AlterTable
ALTER TABLE "budget_adjustment_lines" ADD COLUMN     "new_subject_name" TEXT,
ADD COLUMN     "new_subject_parent_id" UUID,
ALTER COLUMN "subject_id" DROP NOT NULL;
