-- §enhance: 年度科目预算明细(计量单位 / 数量 / 单价)。
-- 金额 = quantity × unitPrice,由 service 层计算并写入 initial_amount。
-- Nullable 以兼容存量行(历史数据无明细)。
ALTER TABLE "subject_budgets" ADD COLUMN "unit" TEXT;
ALTER TABLE "subject_budgets" ADD COLUMN "quantity" DECIMAL(18,2);
ALTER TABLE "subject_budgets" ADD COLUMN "unit_price" DECIMAL(18,2);
