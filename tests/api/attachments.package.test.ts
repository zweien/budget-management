import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { UserRole } from '@prisma/client';
import JSZip from 'jszip';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { createRecord } from '@/server/services/businessRecord.service';
import {
  approveApplication,
  createDraft,
  submitDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { GET } from '@/app/api/projects/[id]/attachments/package/route';

// mock 鉴权:requireUser 返回 admin。
// vi.mock 被提升到 import 之前执行,但工厂返回的 requireUser 仅在测试运行期(beforeAll 之后)
// 被调用,届时 MOCK_ADMIN_ID 已赋值;闭包捕获的是 let 绑定而非初值,故安全。
let MOCK_ADMIN_ID: string;
vi.mock('@/lib/auth/session', async (orig) => {
  const actual = await (orig as () => Promise<typeof import('@/lib/auth/session')>)();
  return {
    ...actual,
    requireUser: async () => ({ id: MOCK_ADMIN_ID, role: UserRole.ADMIN, name: 'admin' }) as never,
  };
});

/**
 * 构造合法 InitialBudgetPayload:1 根(根科目)+ 1 叶(叶科目),1 年度 2026。
 *
 * NOTE(brief 对齐):原 brief 草稿写成 `createDraft(pid, {year,initialAmount,lines:[...]})`,
 * 但真实 createDraft 签名是 `(projectId, InitialBudgetPayload, user)`,返回 `{ appId }`
 * (非 `{ id }`),且 subjectBudgets 必须带 unit/quantity/unitPrice(service 端重算 amount)。
 * 此处抄 tests/server/businessRecord.service.test.ts 的 validPayload 真实形态。
 */
function validPayload(): InitialBudgetPayload {
  return {
    projectTotal: '100000.00',
    annualBudgets: [{ year: 2026, amount: '100000.00' }],
    subjects: [
      { code: 'ROOT', name: '根科目', parentCode: null, isLeaf: false },
      { code: 'LEAF', name: '叶科目', parentCode: 'ROOT', isLeaf: true },
    ],
    subjectBudgets: [
      // 金额 = 数量 × 单价(service 端重算):100 × 1000.00 = 100000.00。
      {
        year: 2026,
        subjectCode: 'LEAF',
        amount: '100000.00',
        unit: '次',
        quantity: '100.00',
        unitPrice: '1000.00',
      },
    ],
    subjectTotalBudgets: [{ subjectCode: 'LEAF', amount: '100000.00' }],
  };
}

/**
 * 建项目 + 编制 + 提交 + 审批生效 → 返回 project(叶科目已落库)。
 * 对齐 businessRecord.service.test.ts / Task 4 attachments.route.test.ts 的真实形态。
 */
async function seedApprovedProject(adminId: string) {
  const project = await createProject(
    { code: `PK-${uuidv7().slice(0, 8)}`, name: `package ${uuidv7().slice(0, 4)}` },
    { id: adminId, role: UserRole.ADMIN },
  );
  // createProject 不建科目 → 走 createDraft→submit→approve 落库叶科目。
  const { appId } = await createDraft(project.id, validPayload(), {
    id: adminId,
    role: UserRole.ADMIN,
  });
  await submitDraft(appId, { id: adminId, role: UserRole.ADMIN });
  await approveApplication(appId, { id: adminId, role: UserRole.ADMIN });
  return project;
}

const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.recordAttachment.deleteMany({ where: { record: { projectId } } }).catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectTotalBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.annualBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.receiptRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.initialBudgetApplication.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

describe('attachments package route (按科目层级打包)', () => {
  const createdProjectIds: string[] = [];
  let projectId: string;
  let leafSubjectId: string;
  let recordId: string;

  beforeAll(async () => {
    await prisma.$connect();
    MOCK_ADMIN_ID = uuidv7();
    await prisma.user.create({
      data: { id: MOCK_ADMIN_ID, name: 'admin-pkg', role: UserRole.ADMIN },
    });
    const project = await seedApprovedProject(MOCK_ADMIN_ID);
    createdProjectIds.push(project.id);
    projectId = project.id;
    leafSubjectId = await prisma.budgetSubject
      .findFirst({ where: { projectId, isLeaf: true }, select: { id: true } })
      .then((s) => s!.id);
    // 建一条业务记录(挂在叶科目)。
    const { record } = await createRecord(
      projectId,
      {
        budgetYear: 2026,
        subjectId: leafSubjectId,
        amount: '1200.00',
        businessDate: '2026-08-05',
        handler: '张三',
        summary: '差旅费',
        status: 'PAID',
      },
      { id: MOCK_ADMIN_ID, role: UserRole.ADMIN },
    );
    recordId = record.id;
    // 上传一个附件(直接写库,跳过 multipart)。
    await prisma.recordAttachment.create({
      data: {
        id: uuidv7(),
        recordId,
        fileName: '发票.pdf',
        contentType: 'application/pdf',
        sizeBytes: 41,
        data: Buffer.from('%PDF-1.4 test'),
        uploadedById: MOCK_ADMIN_ID,
      },
    });
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) await cleanupProject(id);
    await prisma.user.deleteMany({ where: { id: MOCK_ADMIN_ID } }).catch(() => {});
    await prisma.$disconnect();
  });

  async function callPackage(query: string) {
    const url = `http://localhost/api/projects/${projectId}/attachments/package${query}`;
    const req = new Request(url);
    const res = await GET(req as never, { params: Promise.resolve({ id: projectId }) } as never);
    return res;
  }

  it('默认模板打包:文件夹层级 + 文件名正确', async () => {
    const res = await callPackage('');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    // 路径: ROOT_根科目/LEAF_叶科目/2026-08-05_1200.00_差旅费_发票.pdf
    expect(names).toContain('ROOT_根科目/LEAF_叶科目/2026-08-05_1200.00_差旅费_发票.pdf');
  });

  it('自定义模板渲染各占位符', async () => {
    const res = await callPackage('?template={handler}_{status}_{year}_{subject}_{original}');
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.endsWith('张三_PAID_2026_叶科目_发票.pdf'))).toBe(true);
  });

  it('未知占位符原样保留', async () => {
    const res = await callPackage('?template={date}_报销_{original}');
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.endsWith('2026-08-05_报销_发票.pdf'))).toBe(true);
  });

  it('年度筛选:year=2099 无附件 → 404', async () => {
    const res = await callPackage('?year=2099');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain('无附件');
  });

  it('Content-Disposition 双段(ASCII fallback + UTF-8)', async () => {
    const res = await callPackage('');
    const cd = res.headers.get('Content-Disposition') ?? '';
    expect(cd).toContain('filename="attachments.zip"');
    expect(cd).toContain("filename*=UTF-8''");
  });
});
