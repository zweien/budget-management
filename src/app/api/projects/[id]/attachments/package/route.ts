import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';

import { prisma } from '@/lib/prisma';
import { HTTPError, requireUser } from '@/lib/auth/session';
import { countForExport, listForExport } from '@/server/services/recordAttachment.service';
import {
  buildFolderPath,
  dedupeName,
  renderFilename,
  type SubjectNode,
  type TokenContext,
} from '@/lib/attachments/packagePath';

const PACKAGE_MAX_ATTACHMENTS = 500;
const DEFAULT_TEMPLATE = '{date}_{amount}_{summary}_{original}';

/**
 * GET /api/projects/:id/attachments/package?year=&template= — 按预算科目层级打包全部附件。
 * 文件夹:根→叶 walk parentId,每段 `${code}_${name}`。
 * 文件名:占位符模板(默认 {date}_{amount}_{summary}_{original})。
 * 无附件 → 404;附件数 > 500 → 413(防 OOM)。权限:project:view。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    const sp = (req.nextUrl ?? new URL(req.url)).searchParams;
    const year = sp.get('year') ? Number(sp.get('year')) : undefined;
    const template = sp.get('template') || DEFAULT_TEMPLATE;

    // 堆保护:count 前置,超上限直接 413。
    const count = await countForExport(projectId, { budgetYear: year }, user);
    if (count > PACKAGE_MAX_ATTACHMENTS) {
      return NextResponse.json(
        { error: `打包附件过多(上限 ${PACKAGE_MAX_ATTACHMENTS} 个),请按年度缩小范围` },
        { status: 413 },
      );
    }

    const rows = await listForExport(projectId, { budgetYear: year }, user);
    if (rows.length === 0) {
      return NextResponse.json({ error: '无附件' }, { status: 404 });
    }

    // 加载项目科目全树(年度无关),建 id→node map 供路径构建。
    const subjects = await prisma.budgetSubject.findMany({
      where: { projectId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true, name: true, parentId: true, level: true, isLeaf: true },
    });
    const subjectById = new Map<string, SubjectNode>(subjects.map((s) => [s.id, s]));

    const [project, leafNameById] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }),
      Promise.resolve(
        new Map(subjects.filter((s) => s.isLeaf).map((s) => [s.id, s.name] as const)),
      ),
    ]);

    const zip = new JSZip();
    // per-folder 去重 map:folderPath → (filename → count)
    const usedByFolder = new Map<string, Map<string, number>>();

    for (const r of rows) {
      const folder = buildFolderPath(r.record.subjectId, subjectById);
      const ctx: TokenContext = {
        date: r.record.businessDate.toISOString().slice(0, 10),
        amount: r.record.amount.toFixed(2),
        handler: r.record.handler,
        subject: leafNameById.get(r.record.subjectId) ?? '',
        summary: (r.record.summary || '').slice(0, 40),
        status: r.record.status,
        year: String(r.record.budgetYear),
        original: r.attachment.fileName,
      };
      const baseName = renderFilename(template, ctx);
      let used = usedByFolder.get(folder);
      if (!used) {
        used = new Map<string, number>();
        usedByFolder.set(folder, used);
      }
      const finalName = dedupeName(baseName, used);
      const entry = folder ? `${folder}/${finalName}` : finalName;
      zip.file(entry, r.data);
    }

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const projectName = project?.name ?? projectId;
    const zipName = encodeURIComponent(`附件_${projectName}${year ? `_${year}` : ''}.zip`);
    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="attachments.zip"; filename*=UTF-8''${zipName}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof HTTPError)
      return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
