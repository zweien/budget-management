-- CreateTable
CREATE TABLE "subject_total_budgets" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "initial_amount" DECIMAL(18,2) NOT NULL,
    "adjustment_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "current_amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "subject_total_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subject_total_budgets_project_id_subject_id_key" ON "subject_total_budgets"("project_id", "subject_id");

-- AddForeignKey
ALTER TABLE "subject_total_budgets" ADD CONSTRAINT "subject_total_budgets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_total_budgets" ADD CONSTRAINT "subject_total_budgets_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "budget_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

