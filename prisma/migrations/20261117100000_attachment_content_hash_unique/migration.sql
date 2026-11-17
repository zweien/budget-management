-- 附件内容去重的 DB 兜底(codex review):并发同记录同内容上传时,
-- 服务层事务外 check-then-insert 存在竞窗,双写各存一份。
-- 部分唯一索引让第二次写入 P2002,服务层捕获后按 duplicate 返回
-- (与 docNo 查重的 ADR 0002「DB 索引兜底」同款)。
CREATE UNIQUE INDEX IF NOT EXISTS "record_attachments_record_hash_unique"
  ON "record_attachments" ("record_id", "content_hash");
