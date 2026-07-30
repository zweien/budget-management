-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('PROJECT_OWNER', 'AUTHORIZED_HANDLER', 'BUDGET_ADMIN');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'HANDLER');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "BusinessStatus" AS ENUM ('PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'PAID');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('PROJECT_TOTAL', 'ANNUAL', 'SUBJECT', 'SUBJECT_TRANSFER');

-- CreateEnum
CREATE TYPE "LineDirection" AS ENUM ('INCREASE', 'DECREASE');

-- CreateEnum
CREATE TYPE "LevelType" AS ENUM ('PROJECT', 'ANNUAL', 'SUBJECT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" TEXT,
    "start_date" DATE,
    "end_date" DATE,
    "owner_id" UUID NOT NULL,
    "remark" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "member_role" "MemberRole" NOT NULL,
    "authorized_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_subjects" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "parent_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "level" INTEGER NOT NULL,
    "is_leaf" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_budgets" (
    "project_id" UUID NOT NULL,
    "initial_amount" DECIMAL(18,2) NOT NULL,
    "adjustment_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "current_amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "project_budgets_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "annual_budgets" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "initial_amount" DECIMAL(18,2) NOT NULL,
    "adjustment_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "current_amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "annual_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_budgets" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "subject_id" UUID NOT NULL,
    "initial_amount" DECIMAL(18,2) NOT NULL,
    "adjustment_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "current_amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "subject_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "initial_budget_applications" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "applicant_id" UUID NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "approver_id" UUID,
    "approved_at" TIMESTAMP(3),
    "opinion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "initial_budget_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_adjustments" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT,
    "applicant_id" UUID NOT NULL,
    "approver_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),

    CONSTRAINT "budget_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_adjustment_lines" (
    "id" UUID NOT NULL,
    "adjustment_id" UUID NOT NULL,
    "level_type" "LevelType" NOT NULL,
    "year" INTEGER,
    "subject_id" UUID,
    "direction" "LineDirection" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "budget_adjustment_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_locks" (
    "id" UUID NOT NULL,
    "adjustment_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "year" INTEGER,
    "subject_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "budget_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_change_applications" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "before_snapshot" JSONB NOT NULL,
    "after_snapshot" JSONB NOT NULL,
    "applicant_id" UUID NOT NULL,
    "approver_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subject_change_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_records" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "budget_year" INTEGER NOT NULL,
    "subject_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "business_date" DATE NOT NULL,
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handler" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "BusinessStatus" NOT NULL,
    "remark" TEXT,
    "is_void" BOOLEAN NOT NULL DEFAULT false,
    "void_reason" TEXT,
    "voided_by" UUID,
    "voided_at" TIMESTAMP(3),
    "created_by" UUID NOT NULL,
    "modified_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_record_history" (
    "id" UUID NOT NULL,
    "business_record_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "before_data" JSONB,
    "after_data" JSONB,
    "operator_id" UUID NOT NULL,
    "operated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "business_record_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_records" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "receipt_date" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "summary" TEXT,
    "remark" TEXT,
    "creator_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "template_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "creator_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_no" INTEGER NOT NULL,
    "parsed_data" JSONB NOT NULL,
    "validation_status" TEXT NOT NULL,
    "errors" JSONB,
    "duplicate_flag" BOOLEAN NOT NULL DEFAULT false,
    "forced_import" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_logs" (
    "id" UUID NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "operator_id" UUID NOT NULL,
    "opinion" TEXT,
    "operated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before_data" JSONB,
    "after_data" JSONB,
    "operator_id" UUID NOT NULL,
    "operated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_code_key" ON "projects"("code");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_project_id_user_id_key" ON "project_members"("project_id", "user_id");

-- CreateIndex
CREATE INDEX "budget_subjects_project_id_idx" ON "budget_subjects"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_subjects_project_id_code_key" ON "budget_subjects"("project_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "annual_budgets_project_id_year_key" ON "annual_budgets"("project_id", "year");

-- CreateIndex
CREATE INDEX "subject_budgets_project_id_year_idx" ON "subject_budgets"("project_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "subject_budgets_project_id_year_subject_id_key" ON "subject_budgets"("project_id", "year", "subject_id");

-- CreateIndex
CREATE INDEX "budget_locks_subject_id_released_at_idx" ON "budget_locks"("subject_id", "released_at");

-- CreateIndex
CREATE INDEX "business_records_project_id_budget_year_subject_id_is_void_idx" ON "business_records"("project_id", "budget_year", "subject_id", "is_void");

-- CreateIndex
CREATE INDEX "business_records_project_id_budget_year_idx" ON "business_records"("project_id", "budget_year");

-- CreateIndex
CREATE INDEX "approval_logs_object_type_object_id_idx" ON "approval_logs"("object_type", "object_id");

-- CreateIndex
CREATE INDEX "audit_logs_object_type_object_id_idx" ON "audit_logs"("object_type", "object_id");

-- CreateIndex
CREATE INDEX "audit_logs_project_id_idx" ON "audit_logs"("project_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_subjects" ADD CONSTRAINT "budget_subjects_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_subjects" ADD CONSTRAINT "budget_subjects_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "budget_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annual_budgets" ADD CONSTRAINT "annual_budgets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_budgets" ADD CONSTRAINT "subject_budgets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_budgets" ADD CONSTRAINT "subject_budgets_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "budget_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "initial_budget_applications" ADD CONSTRAINT "initial_budget_applications_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "initial_budget_applications" ADD CONSTRAINT "initial_budget_applications_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_adjustments" ADD CONSTRAINT "budget_adjustments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_adjustment_lines" ADD CONSTRAINT "budget_adjustment_lines_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "budget_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_locks" ADD CONSTRAINT "budget_locks_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "budget_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_records" ADD CONSTRAINT "business_records_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_records" ADD CONSTRAINT "business_records_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "budget_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_records" ADD CONSTRAINT "business_records_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_records" ADD CONSTRAINT "business_records_modified_by_fkey" FOREIGN KEY ("modified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_record_history" ADD CONSTRAINT "business_record_history_business_record_id_fkey" FOREIGN KEY ("business_record_id") REFERENCES "business_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_records" ADD CONSTRAINT "receipt_records_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_records" ADD CONSTRAINT "receipt_records_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_logs" ADD CONSTRAINT "approval_logs_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
