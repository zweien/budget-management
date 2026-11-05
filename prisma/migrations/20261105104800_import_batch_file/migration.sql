-- AlterTable
ALTER TABLE "import_batches" ADD COLUMN     "file_data" BYTEA,
ADD COLUMN     "file_size_bytes" INTEGER;
