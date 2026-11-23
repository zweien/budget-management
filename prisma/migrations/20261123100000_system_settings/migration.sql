-- CreateTable
-- 系统设置单例 + 系统标志字节(ADR 0004)。设置是实例级数据:进快照备份,不进迁移包。
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_logos" (
    "key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_logos_pkey" PRIMARY KEY ("key")
);
