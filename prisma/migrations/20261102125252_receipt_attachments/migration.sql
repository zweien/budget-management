-- CreateTable
CREATE TABLE "receipt_attachments" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "receipt_attachments_receipt_id_idx" ON "receipt_attachments"("receipt_id");

-- AddForeignKey
ALTER TABLE "receipt_attachments" ADD CONSTRAINT "receipt_attachments_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipt_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_attachments" ADD CONSTRAINT "receipt_attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
