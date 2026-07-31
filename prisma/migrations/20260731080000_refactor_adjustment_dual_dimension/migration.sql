-- 重构预算调整为「科目双维度调整」(总预算 + 年度预算),不再区分类型/方向。

-- 1) budget_adjustments:删除 type 列,新增 year 列(统一年度)。
ALTER TABLE "budget_adjustments" DROP COLUMN "type";
ALTER TABLE "budget_adjustments" ADD COLUMN "year" INTEGER NOT NULL DEFAULT 2026;

-- 2) budget_adjustment_lines:删除 level_type/direction/amount(year/subject_id 改为非空),
--    新增 total_adjustment / annual_adjustment 双金额列,并补 subject_id 外键。
ALTER TABLE "budget_adjustment_lines" ALTER COLUMN "year" SET NOT NULL;
ALTER TABLE "budget_adjustment_lines" ALTER COLUMN "subject_id" SET NOT NULL;
ALTER TABLE "budget_adjustment_lines" ADD COLUMN "total_adjustment" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "budget_adjustment_lines" ADD COLUMN "annual_adjustment" DECIMAL(18,2) NOT NULL DEFAULT 0;
ALTER TABLE "budget_adjustment_lines" DROP COLUMN "level_type";
ALTER TABLE "budget_adjustment_lines" DROP COLUMN "direction";
ALTER TABLE "budget_adjustment_lines" DROP COLUMN "amount";
ALTER TABLE "budget_adjustment_lines"
  ADD CONSTRAINT "budget_adjustment_lines_subject_id_fkey"
  FOREIGN KEY ("subject_id") REFERENCES "budget_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3) 删除不再使用的枚举类型。
DROP TYPE "AdjustmentType";
DROP TYPE "LineDirection";
DROP TYPE "LevelType";
