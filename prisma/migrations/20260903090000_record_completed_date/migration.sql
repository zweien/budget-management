-- 业务记录新增「完成日期」(报销完成,财务系统后续导出回填;可空)。
-- 「业务发生日期」更名为「申请日期」仅为展示层标签,存储字段 business_date 不变。
ALTER TABLE "business_records" ADD COLUMN IF NOT EXISTS "completed_date" DATE;
