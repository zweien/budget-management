-- AlterTable
-- 记账凭证号(财务记账后补录,对账参考);可空、不唯一、不参与查重,故不加索引。
ALTER TABLE "business_records" ADD COLUMN     "voucherNo" TEXT;
