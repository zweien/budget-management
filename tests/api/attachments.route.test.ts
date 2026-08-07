import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { UserRole } from '@prisma/client';

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
import {
  POST as uploadPost,
  GET as listGet,
} from '@/app/api/projects/[id]/records/[recordId]/attachments/route';
import {
  GET as downloadGet,
  DELETE as attDelete,
} from '@/app/api/projects/[id]/records/[recordId]/attachments/[attId]/route';

// mock 鉴权:所有 requireUser() 返回 admin。
// 注意:vi.mock 被 vitest 提升至 import 之前执行,但工厂返回的 requireUser 仅在测试运行期
// (beforeAll 之后)被调用,届时 MOCK_ADMIN_ID 已赋值;闭包捕获的是 let 绑定而非初值,故安全。
vi.mock('@/lib/auth/session', async (orig) => {
  const actual = await (orig as () => Promise<typeof import('@/lib/auth/session')>)();
  return {
    ...actual,
    requireUser: async () => ({ id: MOCK_ADMIN_ID, role: UserRole.ADMIN, name: 'admin' }) as never,
  };
});

let MOCK_ADMIN_ID: string;

const cleanupProject = async (projectId: string) => {
  if (!projectId) return;
  await prisma.recordAttachment.deleteMany({ where: { record: { projectId } } }).catch(() => {});
  await prisma.businessRecordHistory
    .deleteMany({ where: { businessRecord: { projectId } } })
    .catch(() => {});
  await prisma.businessRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectTotalBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.subjectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.annualBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.budgetSubject.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.initialBudgetApplication.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.receiptRecord.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectBudget.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {});
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {});
};

/**
 * 计划修订(Task 4 夹具调整):原 brief 直接 createProject 后 findFirst 叶科目,
 * 但 createProject 不建立科目树(参见 Task 3 lessons learned),会抛"夹具:无叶科目"。
 * 这里复用 Task 3 / businessRecord.service.test.ts 的 seedApprovedProject 模式:
 * createDraft → submitDraft → approveApplication 落库叶科目,再 createRecord。
 */
function validPayload(): InitialBudgetPayload {
  return {
    projectTotal: '1000.00',
    annualBudgets: [{ year: 2026, amount: '1000.00' }],
    subjects: [
      { code: 'ROOT', name: '根', parentCode: null, isLeaf: false },
      { code: 'A', name: '叶A', parentCode: 'ROOT', isLeaf: true },
    ],
    subjectBudgets: [
      {
        year: 2026,
        subjectCode: 'A',
        amount: '1000.00',
        unit: '次',
        quantity: '10.00',
        unitPrice: '100.00',
      },
    ],
    subjectTotalBudgets: [{ subjectCode: 'A', amount: '1000.00' }],
  };
}

describe('attachments API routes (integration)', () => {
  const createdProjectIds: string[] = [];
  let projectId: string;
  let recordId: string;

  beforeAll(async () => {
    await prisma.$connect();
    MOCK_ADMIN_ID = uuidv7();
    await prisma.user.create({
      data: { id: MOCK_ADMIN_ID, name: 'admin-route', role: UserRole.ADMIN },
    });
    const project = await createProject(
      { code: `RT-${uuidv7().slice(0, 8)}`, name: 'route test' },
      { id: MOCK_ADMIN_ID, role: UserRole.ADMIN },
    );
    createdProjectIds.push(project.id);
    projectId = project.id;

    // 计划修订:createProject 不种科目;走 initialBudget 审批流以落库叶科目。
    const { appId } = await createDraft(project.id, validPayload(), {
      id: MOCK_ADMIN_ID,
      role: UserRole.ADMIN,
    });
    await submitDraft(appId, { id: MOCK_ADMIN_ID, role: UserRole.ADMIN });
    await approveApplication(appId, { id: MOCK_ADMIN_ID, role: UserRole.ADMIN });

    const subject = await prisma.budgetSubject.findFirst({ where: { projectId, isLeaf: true } });
    if (!subject) throw new Error('夹具:无叶科目');
    const { record } = await createRecord(
      projectId,
      {
        budgetYear: 2026,
        subjectId: subject.id,
        amount: '10.00',
        businessDate: '2026-08-05',
        handler: 'x',
        summary: 'route',
        status: 'PLACEHOLDER',
      },
      { id: MOCK_ADMIN_ID, role: UserRole.ADMIN },
    );
    recordId = record.id;
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) await cleanupProject(id);
    await prisma.user.deleteMany({ where: { id: MOCK_ADMIN_ID } }).catch(() => {});
    await prisma.$disconnect();
  });

  function makeUploadReq(file: { name: string; type: string; bytes: Buffer }) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
    return new Request(
      `http://localhost/api/projects/${projectId}/records/${recordId}/attachments`,
      {
        method: 'POST',
        body: form,
      },
    ) as never; // NextRequest 兼容
  }

  it('上传 → 列表 → 下载(bytea 一致)→ 删除 → 列表为空', async () => {
    // 上传。
    const payload = Buffer.from('INVOICE-CONTENT');
    const res1 = await uploadPost(
      makeUploadReq({ name: '发票.pdf', type: 'application/pdf', bytes: payload }),
      {
        params: Promise.resolve({ id: projectId, recordId }),
      } as never,
    );
    expect(res1.status).toBe(201);
    const meta = await res1.json();
    expect(meta.fileName).toBe('发票.pdf');

    // 列表。
    const res2 = await listGet(
      new Request(
        `http://localhost/api/projects/${projectId}/records/${recordId}/attachments`,
      ) as never,
      {
        params: Promise.resolve({ id: projectId, recordId }),
      } as never,
    );
    expect(res2.status).toBe(200);
    const list = await res2.json();
    expect(list.attachments.length).toBe(1);

    // 下载:Content-Disposition 含文件名;body 字节一致。
    const res3 = await downloadGet(
      new Request(
        `http://localhost/api/projects/${projectId}/records/${recordId}/attachments/${meta.id}`,
      ) as never,
      { params: Promise.resolve({ id: projectId, recordId, attId: meta.id }) } as never,
    );
    expect(res3.status).toBe(200);
    expect(res3.headers.get('Content-Disposition')).toContain('attachment');
    const dl = Buffer.from(await res3.arrayBuffer());
    expect(dl.equals(payload)).toBe(true);

    // 删除。
    const res4 = await attDelete(
      new Request(
        `http://localhost/api/projects/${projectId}/records/${recordId}/attachments/${meta.id}`,
        { method: 'DELETE' },
      ) as never,
      { params: Promise.resolve({ id: projectId, recordId, attId: meta.id }) } as never,
    );
    expect(res4.status).toBe(204);

    // 列表为空。
    const res5 = await listGet(
      new Request(
        `http://localhost/api/projects/${projectId}/records/${recordId}/attachments`,
      ) as never,
      {
        params: Promise.resolve({ id: projectId, recordId }),
      } as never,
    );
    const list2 = await res5.json();
    expect(list2.attachments.length).toBe(0);
  });

  it('上传非文件字段 → 400', async () => {
    const form = new FormData();
    form.append('file', 'not-a-file');
    const res = await uploadPost(
      new Request(`http://localhost/api/projects/${projectId}/records/${recordId}/attachments`, {
        method: 'POST',
        body: form,
      }) as never,
      { params: Promise.resolve({ id: projectId, recordId }) } as never,
    );
    expect(res.status).toBe(400);
  });

  it('导出:有附件返回 zip;无附件返回 404', async () => {
    const { GET: exportGet } = await import('@/app/api/projects/[id]/attachments/export/route');
    // 先上传一个附件用于导出。
    const payload = Buffer.from('ZIP-CONTENT');
    const up = await uploadPost(
      makeUploadReq({ name: 'z.pdf', type: 'application/pdf', bytes: payload }),
      {
        params: Promise.resolve({ id: projectId, recordId }),
      } as never,
    );
    expect(up.status).toBe(201);

    const res = await exportGet(
      new Request(
        `http://localhost/api/projects/${projectId}/attachments/export?budgetYear=2026`,
      ) as never,
      { params: Promise.resolve({ id: projectId }) } as never,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    // body 非空(zip 字节)。
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    // zip 魔数 PK\x03\x04。
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);

    // 无附件范围(2099 年)→ 404。
    const none = await exportGet(
      new Request(
        `http://localhost/api/projects/${projectId}/attachments/export?budgetYear=2099`,
      ) as never,
      { params: Promise.resolve({ id: projectId }) } as never,
    );
    expect(none.status).toBe(404);
  });
});
