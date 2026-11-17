import { NextRequest, NextResponse } from 'next/server';

import { readJson, withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { denyApiKeyCrossProject } from '@/lib/auth/permissions';
import {
  matchAttachmentsPreview,
  parseMatchPreviewFiles,
} from '@/server/services/attachmentMatch.service';

/**
 * POST /api/attachments/match-preview — 批量附件导入的匹配预览(统一导入入口,跨项目)。
 * body 同项目内入口;候选仅限用户有 record:edit 的非归档项目,
 * 唯一命中自动归属、同号跨项目标歧义待人工指定项目。
 * 跨项目接口:指定项目范围的 API 凭证一律 403(与统计/审计全量同口径)。
 */
export const POST = withRoute(async (req: NextRequest) => {
  const user = await requireUser();
  await denyApiKeyCrossProject(user, 'record:edit');
  const files = parseMatchPreviewFiles(await readJson(req).catch(() => null));
  const result = await matchAttachmentsPreview(files, user);
  return NextResponse.json(result);
});
