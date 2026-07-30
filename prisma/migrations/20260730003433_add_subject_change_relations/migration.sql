-- AlterTable
ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "subject_change_applications" ADD CONSTRAINT "subject_change_applications_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_change_applications" ADD CONSTRAINT "subject_change_applications_applicant_id_fkey" FOREIGN KEY ("applicant_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_change_applications" ADD CONSTRAINT "subject_change_applications_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
