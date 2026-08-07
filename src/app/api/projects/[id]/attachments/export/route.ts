import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';

import { prisma } from '@/lib/prisma';
import { HTTPError, requireUser } from '@/lib/auth/session';
import { listForExport } from '@/server/services/recordAttachment.service';

/**
 * 导出附件数量硬上限:防止 listForExport 把全部 bytea 读进内存 + zip.generateAsync
 * 再生成一整个 nodebuffer,大量 50MB 附件会把 Node 堆打爆(OOM-kill)。
 * 超过即拒绝(413),提示缩小筛选范围;服务层 listForExport 保持通用查询语义,不限流。
 */
const EXPORT_MAX_ATTACHMENTS = 500;

/**
 * GET /api/projects/:id/attachments/export?budgetYear=&subjectId= — 批量打包导出附件 zip。
 * 沿用记录页筛选(年度/科目)。zip 内文件名:`<业务日期>_<摘要>_<原文件名>`(冲突追加序号)。
 * 无附件 → 404;附件数超 EXPORT_MAX_ATTACHMENTS → 413(避免堆耗尽)。
 * 权限:project:view(全局只读 USER 也可导出查阅)。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    // 优先用 NextRequest.nextUrl(Next 运行时);测试期传入裸 Request 时回退到 new URL(req.url)。
    // 二者 searchParams 语义一致,统一一处取值。
    const sp = (req.nextUrl ?? new URL(req.url)).searchParams;
    const budgetYear = sp.get('budgetYear') ? Number(sp.get('budgetYear')) : undefined;
    const subjectId = sp.get('subjectId') || undefined;

    const rows = await listForExport(projectId, { budgetYear, subjectId }, user);
    if (rows.length === 0) {
      return NextResponse.json({ error: '所选范围内无附件' }, { status: 404 });
    }
    // 堆保护:附件过多则拒绝(在 materialize 全部 bytea 之后、构建 zip 之前切断)。
    if (rows.length > EXPORT_MAX_ATTACHMENTS) {
      return NextResponse.json(
        { error: `导出附件过多(上限 ${EXPORT_MAX_ATTACHMENTS} 个),请缩小筛选范围` },
        { status: 413 },
      );
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    });

    const zip = new JSZip();
    const used = new Map<string, number>(); // 去重计数
    for (const r of rows) {
      const date = r.record.businessDate.toISOString().slice(0, 10); // yyyy-mm-dd
      const safeSummary = (r.record.summary || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
      // 与 safeSummary 同款消毒:替换路径分隔符/Windows 非法字符/NUL,
      // 防止 ../evil.pdf 之类的 zip-slip(部分解压器会按条目相对路径写出工作目录之外)。
      const safeName = r.attachment.fileName.replace(/[\\/:*?"<>|\0]/g, '_');
      const base = `${date}_${safeSummary}_${safeName}`.replace(/\s+/g, '_');
      let name = base;
      const count = used.get(base) ?? 0;
      if (count > 0) {
        const dot = base.lastIndexOf('.');
        name = dot > 0 ? `${base.slice(0, dot)}(${count})${base.slice(dot)}` : `${base}(${count})`;
      }
      used.set(base, count + 1);
      zip.file(name, r.data);
    }

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const projectName = project?.name ?? projectId;
    const zipName = encodeURIComponent(
      `附件_${projectName}${budgetYear ? `_${budgetYear}` : ''}.zip`,
    );
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
