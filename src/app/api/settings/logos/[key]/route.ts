import { NextRequest, NextResponse } from 'next/server';

import { withRoute } from '@/lib/api/withRoute';
import { getSystemLogo } from '@/server/services/systemSetting.service';

/**
 * GET /api/settings/logos/:key — 系统标志字节(key = standard | dark | compact)。
 * 匿名可读(登录页在认证前就要显示标志;ADR 0004)。地址带版本号(?v=<更新时间戳>)时内容
 * 不可变、可长缓存;不带版本号只给短缓存,标志更换后旧图不会滞留一年。
 * 另下发隔离型 CSP:`<img>` 引用不受影响,但直接打开该地址也不执行任何脚本(SVG 防线)。
 */
export const dynamic = 'force-dynamic';

const IMMUTABLE = 'public, max-age=31536000, immutable';
const UNVERSIONED = 'public, max-age=60';
const ISOLATION_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export const GET = withRoute(
  async (req: NextRequest, { params }: { params: Promise<{ key: string }> }) => {
    const { key } = await params;
    const logo = await getSystemLogo(key);
    const version = String(logo.updatedAt.getTime());
    const cacheControl =
      new URL(req.url).searchParams.get('v') === version ? IMMUTABLE : UNVERSIONED;
    const etag = `"${key}-${version}-${logo.sizeBytes}"`;
    if (req.headers.get('if-none-match') === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: etag, 'Cache-Control': cacheControl },
      });
    }
    return new NextResponse(logo.data as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': logo.contentType,
        'Content-Length': String(logo.sizeBytes),
        'Cache-Control': cacheControl,
        ETag: etag,
        'Content-Security-Policy': ISOLATION_CSP,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
);
