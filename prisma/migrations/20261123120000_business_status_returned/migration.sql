-- AlterEnum
-- 业务退单:结算单导入的「业务退单」行不再跳过,入账为该状态(计入应付未付,与在途态同口径)。
-- 置于「已支出」之前:在途/待处理态在前、终态在后,与 schema.prisma 的取值顺序一致。
ALTER TYPE "BusinessStatus" ADD VALUE 'RETURNED' BEFORE 'PAID';
