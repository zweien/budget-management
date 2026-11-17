import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { createProject } from '@/server/services/project.service';
import { createRecord, voidRecord } from '@/server/services/businessRecord.service';
import {
  approveApplication,
  createDraft,
  submitDraft,
  type InitialBudgetPayload,
} from '@/server/services/initialBudget.service';
import { createAttachment } from '@/server/services/recordAttachment.service';
import { POST as projectPreviewPost } from '@/app/api/projects/[id]/attachments/match-preview/route';
import { POST as globalPreviewPost } from '@/app/api/attachments/match-preview/route';

// mock 鉴权:requireUser() 返回可变 MOCK_USER(admin / 局外人 / selected 范围凭证按用例切换)。
vi.mock('@/lib/auth/session', async (orig) => {
  const actual = await (orig as () => Promise<typeof import('@/lib/auth/session')>)();
  return {
    ...actual,
    requireUser: async () => MOCK_USER as never,
  };
});

let MOCK_USER: {
  id: string;
  role: UserRole;
  name: string;
  viaApiKey?: boolean;
  keyProjectScope?: string;
  apiKeyPrefix?: string;
};

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

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

/** 建已审批项目 + 一条带单据编号的业务记录。 */
async function seedRecordWithDocNo(suffix: string, docNo: string) {
  const project = await createProject(
    { code: `MP-${suffix}-${uuidv7().slice(0, 8)}`, name: `批量附件 ${suffix}` },
    MOCK_USER,
  );
  const { appId } = await createDraft(project.id, validPayload(), MOCK_USER);
  await submitDraft(appId, MOCK_USER);
  await approveApplication(appId, MOCK_USER);
  const subject = await prisma.budgetSubject.findFirst({
    where: { projectId: project.id, isLeaf: true },
  });
  if (!subject) throw new Error('测试夹具:项目无叶科目');
  const { record } = await createRecord(
    project.id,
    {
      budgetYear: 2026,
      subjectId: subject.id,
      amount: '100.00',
      businessDate: '2026-08-05',
      handler: '张三',
      summary: `批量附件-${suffix}`,
      status: 'PLACEHOLDER',
      docNo,
    },
    MOCK_USER,
  );
  return { project, record };
}

describe('批量附件匹配预览 API(项目内 + 跨项目)', () => {
  const createdProjectIds: string[] = [];
  let adminId: string;
  let outsiderId: string;
  let p1: { id: string; name: string };
  let pVoid: { id: string };
  let docNoShared: string;
  let docNoVoided: string;
  let docNoP2Only: string;
  let r1Id: string;
  let knownHash: string;

  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    outsiderId = uuidv7();
    await prisma.user.createMany({
      data: [
        { id: adminId, name: 'admin-matchpreview', role: UserRole.ADMIN },
        { id: outsiderId, name: 'outsider-matchpreview', role: UserRole.USER },
      ],
    });
    MOCK_USER = { id: adminId, role: UserRole.ADMIN, name: 'admin-matchpreview' };

    // 注意不能用 uuidv7 头部:那是毫秒时间戳,同毫秒建的四个编号会完全相同;取随机尾部。
    const newDocNo = () => `TYBXMP${uuidv7().replaceAll('-', '').slice(-13)}`;
    docNoShared = newDocNo();
    docNoVoided = newDocNo();
    docNoP2Only = newDocNo();

    // P1:共享编号 + 将被作废的编号;P2:同共享编号(跨项目歧义)+ 仅 P2 有的编号。
    const seeded1 = await seedRecordWithDocNo('P1-SHARED', docNoShared);
    const seeded2 = await seedRecordWithDocNo('P1-VOID', docNoVoided);
    const seeded3 = await seedRecordWithDocNo('P2-SHARED', docNoShared);
    const seeded4 = await seedRecordWithDocNo('P2-ONLY', docNoP2Only);
    createdProjectIds.push(
      seeded1.project.id,
      seeded2.project.id,
      seeded3.project.id,
      seeded4.project.id,
    );
    p1 = { id: seeded1.project.id, name: seeded1.project.name };
    pVoid = { id: seeded2.project.id };
    r1Id = seeded1.record.id;
    await voidRecord(seeded2.record.id, '测试作废', MOCK_USER);

    // 在 P1 的共享编号记录上放一个已知内容附件,预览应标 duplicate。
    knownHash = sha256('KNOWN-ATTACHMENT-CONTENT');
    await createAttachment(
      seeded1.record.id,
      {
        name: `${docNoShared}_01.pdf`,
        type: 'application/pdf',
        size: 24,
        buffer: Buffer.from('KNOWN-ATTACHMENT-CONTENT'),
      },
      MOCK_USER,
    );
  });

  afterAll(async () => {
    for (const id of createdProjectIds.splice(0)) await cleanupProject(id);
    // denyApiKeyCrossProject 的被拒审计 operator=测试用户且 projectId 为 NULL,
    // 项目级清理覆盖不到,FK 会阻止删用户(且被 .catch 静默吞掉导致残留)——
    // 先按 operator 清掉这类审计,再删用户。
    await prisma.auditLog
      .deleteMany({ where: { operatorId: { in: [adminId, outsiderId] } } })
      .catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [adminId, outsiderId] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  const postProject = (body: unknown, projectId: string = p1.id) =>
    projectPreviewPost(
      new Request(`http://localhost/api/projects/${projectId}/attachments/match-preview`, {
        method: 'POST',
        body: JSON.stringify(body),
      }) as never,
      { params: Promise.resolve({ id: projectId }) } as never,
    );

  const postGlobal = (body: unknown) =>
    globalPreviewPost(
      // withRoute 导出的签名为 (req, ctx),本路由无路径参数,ctx 传 undefined。
      new Request('http://localhost/api/attachments/match-preview', {
        method: 'POST',
        body: JSON.stringify(body),
      }) as never,
      undefined as never,
    );

  it('项目内预览:matched(含摘要/附件数/重复标记)+ no-record + void-only', async () => {
    const res = await postProject({
      files: [
        { name: `${docNoShared}_01_徐维乐-3722 (1).pdf`, contentHash: knownHash },
        { name: `${docNoShared}_02_补充.pdf` },
        { name: 'TYBXMP99999999_不存在.pdf' },
      ],
    });
    expect(res.status).toBe(200);
    const { files } = await res.json();
    expect(files).toHaveLength(3);

    expect(files[0]).toMatchObject({
      name: `${docNoShared}_01_徐维乐-3722 (1).pdf`,
      status: 'matched',
      duplicate: true,
      record: { recordId: r1Id, docNo: docNoShared, summary: '批量附件-P1-SHARED' },
    });
    expect(files[0].record.attachmentCount).toBe(1);
    expect(files[0].duplicateOfFileName).toBe(`${docNoShared}_01.pdf`);

    expect(files[1]).toMatchObject({ status: 'matched', duplicate: false });
    expect(files[2]).toMatchObject({ status: 'unmatched', reason: 'no-record' });

    // 仅命中作废记录:作废记录不可挂附件(现有规则)→ void-only(在作废记录自己的项目里验证)。
    const resVoid = await postProject({ files: [{ name: `${docNoVoided}_01_x.pdf` }] }, pVoid.id);
    expect(resVoid.status).toBe(200);
    const voidFiles = (await resVoid.json()).files;
    expect(voidFiles[0]).toMatchObject({ status: 'unmatched', reason: 'void-only' });
  });

  it('项目内预览:同项目内同号歧义不可能(唯一索引),预览仅在本项目找', async () => {
    // P2 独有编号在 P1 预览里 → no-record(项目内不跨项目)。
    const res = await postProject({ files: [{ name: `${docNoP2Only}_01.pdf` }] });
    expect(res.status).toBe(200);
    const { files } = await res.json();
    expect(files[0]).toMatchObject({ status: 'unmatched', reason: 'no-record' });
  });

  it('跨项目预览:唯一命中自动归属(带项目名);同号跨项目 → ambiguous 双候选', async () => {
    const res = await postGlobal({
      files: [{ name: `${docNoP2Only}_01.pdf` }, { name: `${docNoShared}_x.pdf` }],
    });
    expect(res.status).toBe(200);
    const { files } = await res.json();
    expect(files[0]).toMatchObject({
      status: 'matched',
      record: { docNo: docNoP2Only, projectName: '批量附件 P2-ONLY' },
    });
    expect(files[1].status).toBe('ambiguous');
    expect(files[1].candidates).toHaveLength(2);
    expect(new Set(files[1].candidates.map((c: { projectId: string }) => c.projectId)).size).toBe(
      2,
    );
  });

  it('跨项目预览:非成员 USER → no-permission(不泄露歧义细节之外的信息)', async () => {
    MOCK_USER = { id: outsiderId, role: UserRole.USER, name: 'outsider-matchpreview' };
    try {
      const res = await postGlobal({ files: [{ name: `${docNoShared}_01.pdf` }] });
      expect(res.status).toBe(200);
      const { files } = await res.json();
      expect(files[0]).toMatchObject({ status: 'unmatched', reason: 'no-permission' });
    } finally {
      MOCK_USER = { id: adminId, role: UserRole.ADMIN, name: 'admin-matchpreview' };
    }
  });

  it('项目内预览:非成员 USER → 403(record:edit 门)', async () => {
    MOCK_USER = { id: outsiderId, role: UserRole.USER, name: 'outsider-matchpreview' };
    try {
      const res = await postProject({ files: [{ name: `${docNoShared}_01.pdf` }] });
      expect(res.status).toBe(403);
    } finally {
      MOCK_USER = { id: adminId, role: UserRole.ADMIN, name: 'admin-matchpreview' };
    }
  });

  it('跨项目预览:指定项目范围 API 凭证 → 403(跨项目接口红线)', async () => {
    MOCK_USER = {
      id: adminId,
      role: UserRole.ADMIN,
      name: 'admin-matchpreview',
      viaApiKey: true,
      keyProjectScope: 'selected',
      apiKeyPrefix: 'bma_test',
    };
    try {
      const res = await postGlobal({ files: [{ name: `${docNoP2Only}_01.pdf` }] });
      expect(res.status).toBe(403);
    } finally {
      MOCK_USER = { id: adminId, role: UserRole.ADMIN, name: 'admin-matchpreview' };
    }
  });

  it('单批超过 100 个文件 → 400', async () => {
    const files = Array.from({ length: 101 }, (_, i) => ({ name: `F${i}_x.pdf` }));
    const res = await postProject({ files });
    expect(res.status).toBe(400);
  });

  it('请求体非法(files 缺失/hash 非法)→ 400', async () => {
    expect((await postProject({})).status).toBe(400);
    expect((await postProject({ files: [{ name: 'a.pdf', contentHash: 'zz' }] })).status).toBe(400);
  });
});
