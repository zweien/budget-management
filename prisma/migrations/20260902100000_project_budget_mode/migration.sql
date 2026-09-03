-- 预算类型(§包干制):LUMP_SUM=总预算不编科目总预算层,年度预算仍分解到科目。
-- 存量项目默认 GENERAL,行为不变。
DO $$ BEGIN
  CREATE TYPE "BudgetMode" AS ENUM ('GENERAL', 'LUMP_SUM');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "budget_mode" "BudgetMode" NOT NULL DEFAULT 'GENERAL';
