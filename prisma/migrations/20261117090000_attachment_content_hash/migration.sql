-- 附件内容去重(CONTEXT.md「附件内容去重」):同一记录下内容相同的附件视为重复,再传跳过。
-- 回填存量指纹用 PG 11+ 内置 sha256()(免扩展);回填完成后收紧 NOT NULL。
ALTER TABLE "record_attachments" ADD COLUMN "content_hash" TEXT;
UPDATE "record_attachments" SET "content_hash" = encode(sha256("data"), 'hex');
ALTER TABLE "record_attachments" ALTER COLUMN "content_hash" SET NOT NULL;
