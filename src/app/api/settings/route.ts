import { NextRequest, NextResponse } from 'next/server';

import { readJson, withRoute } from '@/lib/api/withRoute';
import { requireUser } from '@/lib/auth/session';
import { getSystemSettings, updateSystemSettings } from '@/server/services/systemSetting.service';
import { readSettingsForm } from './_upload';

/**
 * GET /api/settings — 当前生效的系统设置(含标志元数据)。
 * 匿名可读(ADR 0004:登录页在认证前就要渲染标题与标志;接口只放展示类设置)。
 * 不缓存:刷新即见管理员的最新保存。
 */
export const dynamic = 'force-dynamic';

export const GET = withRoute(async () => {
  const settings = await getSystemSettings();
  return NextResponse.json({ settings }, { headers: { 'Cache-Control': 'no-store' } });
});

/**
 * PATCH /api/settings — 保存系统设置(仅 ADMIN 登录会话、拒绝一切 Bearer;服务层把关)。
 * 两种请求体,都只提交本次要改的键:
 * - application/json:标量键,用于不含标志的卡片;
 * - multipart/form-data:文本字段 + `logo[standard|dark|compact]`(文件 = 设置该位,
 *   字符串 "clear" = 清除该位),品牌卡片一次提交、标量与标志同事务生效。
 */
export const PATCH = withRoute(async (req: NextRequest) => {
  const user = await requireUser();
  const contentType = req.headers.get('content-type') ?? '';
  const form = contentType.includes('multipart/form-data')
    ? await readSettingsForm(req)
    : { patch: await readJson(req), logoOps: {} };
  const settings = await updateSystemSettings(user, form.patch, form.logoOps);
  return NextResponse.json({ settings });
});
