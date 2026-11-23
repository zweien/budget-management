/**
 * 系统设置路由测试(ADR 0004)。模式同 migration-package-import.route.test.ts:
 * mock requireUser 可切换身份 + 真实 PG。
 * 覆盖:匿名读取(GET 设置 / 标志)、写入权限矩阵(匿名 401、USER 403、Bearer 403)、
 * JSON 与 multipart 保存(标量 + 标志同事务)、标志响应头(版本化长缓存 / CSP / ETag)。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { UserRole } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { uuidv7 } from '@/lib/id';
import { LOGO_MAX_BYTES } from '@/lib/system-logo';
import {
  invalidateSystemSettingsCache,
  updateSystemSettings,
} from '@/server/services/systemSetting.service';
import { pngBytes } from '../helpers/logo-fixtures';

let mockUser: { id: string; role: UserRole; viaApiKey?: boolean } | null = null;
vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/session')>();
  return {
    ...actual,
    requireUser: async () => {
      if (!mockUser) throw new actual.HTTPError(401, '未登录或用户不存在');
      return mockUser;
    },
  };
});

import { GET as getSettings, PATCH as patchSettings } from '@/app/api/settings/route';
import { GET as getLogo } from '@/app/api/settings/logos/[key]/route';

let adminId: string;
let plainId: string;

const resetSettings = async () => {
  await prisma.systemLogo.deleteMany();
  await prisma.systemSetting.deleteMany();
  // 审计也逐用例清,避免同一操作人跨用例累计。
  await prisma.auditLog
    .deleteMany({ where: { operatorId: { in: [adminId, plainId] } } })
    .catch(() => {});
  invalidateSystemSettingsCache();
};

function jsonReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function formReq(fields: Record<string, string>, files: Record<string, File> = {}): NextRequest {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const [key, file] of Object.entries(files)) form.append(key, file);
  return new NextRequest('http://localhost/api/settings', { method: 'PATCH', body: form });
}

function logoReq(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers });
}

const logoParams = (key: string) => ({ params: Promise.resolve({ key }) });

describe('api/settings(ADR 0004:展示类匿名可读、仅管理员会话可写)', () => {
  beforeAll(async () => {
    await prisma.$connect();
    adminId = uuidv7();
    plainId = uuidv7();
    await prisma.user.createMany({
      data: [
        { id: adminId, name: 'route-admin', role: UserRole.ADMIN },
        { id: plainId, name: 'route-plain', role: UserRole.USER },
      ],
    });
    await resetSettings();
  });

  afterEach(resetSettings);

  afterAll(async () => {
    await resetSettings();
    await prisma.auditLog
      .deleteMany({ where: { operatorId: { in: [adminId, plainId] } } })
      .catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [adminId, plainId] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  describe('GET /api/settings', () => {
    it('匿名可读(登录页在认证前就要渲染标题与标志),且不缓存', async () => {
      mockUser = null;
      const res = await getSettings(
        new NextRequest('http://localhost/api/settings'),
        undefined as never,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const body = (await res.json()) as { settings: { title: string; logos: unknown } };
      expect(body.settings.title).toBe('预算管理系统');
      expect(body.settings.logos).toEqual({ standard: null, dark: null, compact: null });
    });
  });

  describe('PATCH /api/settings — 权限矩阵', () => {
    it('匿名 401', async () => {
      mockUser = null;
      const res = await patchSettings(jsonReq({ title: 'x' }), undefined as never);
      expect(res.status).toBe(401);
    });

    it('普通用户 403', async () => {
      mockUser = { id: plainId, role: UserRole.USER };
      const res = await patchSettings(jsonReq({ title: 'x' }), undefined as never);
      expect(res.status).toBe(403);
      expect(await prisma.systemSetting.count()).toBe(0);
    });

    it('管理员经 Bearer 凭证(含在场交互)403——登录页文案与标志不得被 agent 改写', async () => {
      mockUser = { id: adminId, role: UserRole.ADMIN, viaApiKey: true };
      const res = await patchSettings(jsonReq({ title: 'x' }), undefined as never);
      expect(res.status).toBe(403);
      expect(await prisma.systemSetting.count()).toBe(0);
    });

    it('管理员登录会话 200:JSON 只提交本次要改的键', async () => {
      mockUser = { id: adminId, role: UserRole.ADMIN };
      const res = await patchSettings(jsonReq({ defaultTheme: 'dark' }), undefined as never);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { settings: { defaultTheme: string; title: string } };
      expect(body.settings.defaultTheme).toBe('dark');
      expect(body.settings.title).toBe('预算管理系统');
      expect(await prisma.systemSetting.count()).toBe(1);
    });

    it('请求体不是 JSON → 400;未知键 / 非法取值 → 422', async () => {
      mockUser = { id: adminId, role: UserRole.ADMIN };
      expect((await patchSettings(jsonReq('{oops'), undefined as never)).status).toBe(400);
      expect((await patchSettings(jsonReq({ nope: 1 }), undefined as never)).status).toBe(422);
      expect(
        (await patchSettings(jsonReq({ ledgerBasis: 'yearly' }), undefined as never)).status,
      ).toBe(422);
      expect(await prisma.systemSetting.count()).toBe(0);
    });
  });

  describe('PATCH /api/settings — multipart(品牌卡片:文本 + 标志同事务)', () => {
    it('文本字段与标志文件一次提交:标题生效、标准版入库', async () => {
      mockUser = { id: adminId, role: UserRole.ADMIN };
      const png = pngBytes(32, 32);
      const res = await patchSettings(
        formReq(
          { title: '经费管理平台', subtitle: '' },
          { 'logo[standard]': new File([new Uint8Array(png)], 'logo.png', { type: 'image/png' }) },
        ),
        undefined as never,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        settings: {
          title: string;
          subtitle: string | null;
          logos: Record<string, { url: string } | null>;
        };
      };
      expect(body.settings.title).toBe('经费管理平台');
      expect(body.settings.subtitle).toBeNull();
      expect(body.settings.logos.standard?.url).toMatch(
        /^\/api\/settings\/logos\/standard\?v=\d+$/,
      );
    });

    it('标志非法时整次提交回滚:标题也不落库', async () => {
      mockUser = { id: adminId, role: UserRole.ADMIN };
      const res = await patchSettings(
        formReq(
          { title: '不该生效' },
          { 'logo[standard]': new File(['just text'], 'logo.txt', { type: 'text/plain' }) },
        ),
        undefined as never,
      );
      expect(res.status).toBe(415);
      expect(await prisma.systemSetting.count()).toBe(0);
      expect(await prisma.systemLogo.count()).toBe(0);
    });

    it('logo[位] = "clear" 清除该位;非文件非 clear 的取值 400', async () => {
      mockUser = { id: adminId, role: UserRole.ADMIN };
      await updateSystemSettings(
        { id: adminId, role: UserRole.ADMIN },
        {},
        { standard: { action: 'set', bytes: pngBytes(8, 8) } },
      );
      const cleared = await patchSettings(
        formReq({ 'logo[standard]': 'clear' }),
        undefined as never,
      );
      expect(cleared.status).toBe(200);
      expect(await prisma.systemLogo.count()).toBe(0);

      const bad = await patchSettings(formReq({ 'logo[standard]': 'wat' }), undefined as never);
      expect(bad.status).toBe(400);
    });
  });

  describe('GET /api/settings/logos/:key', () => {
    it('匿名可读;带匹配版本号 → 不可变长缓存;另下发隔离型 CSP 与 nosniff', async () => {
      mockUser = null;
      const png = pngBytes(24, 24);
      const { logos } = await updateSystemSettings(
        { id: adminId, role: UserRole.ADMIN },
        {},
        { standard: { action: 'set', bytes: png } },
      );
      const url = logos.standard!.url;

      const res = await getLogo(logoReq(url), logoParams('standard'));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
      expect(res.headers.get('Content-Security-Policy')).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);

      // 带上 ETag 再请求 → 304,不再传字节。
      const etag = res.headers.get('ETag');
      const revalidated = await getLogo(
        logoReq(url, { 'if-none-match': etag ?? '' }),
        logoParams('standard'),
      );
      expect(revalidated.status).toBe(304);
    });

    it('不带版本号(或版本对不上)→ 只给短缓存,标志更换后旧图不会滞留', async () => {
      mockUser = null;
      await updateSystemSettings(
        { id: adminId, role: UserRole.ADMIN },
        {},
        { standard: { action: 'set', bytes: pngBytes(8, 8) } },
      );
      const res = await getLogo(logoReq('/api/settings/logos/standard'), logoParams('standard'));
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
      const stale = await getLogo(
        logoReq('/api/settings/logos/standard?v=1'),
        logoParams('standard'),
      );
      expect(stale.headers.get('Cache-Control')).toBe('public, max-age=60');
    });

    it('位名非法或未设置 → 404', async () => {
      mockUser = null;
      expect((await getLogo(logoReq('/api/settings/logos/huge'), logoParams('huge'))).status).toBe(
        404,
      );
      expect((await getLogo(logoReq('/api/settings/logos/dark'), logoParams('dark'))).status).toBe(
        404,
      );
    });

    it('大小上限对 multipart 生效:声明长度超限直接 413', async () => {
      mockUser = { id: adminId, role: UserRole.ADMIN };
      const req = new NextRequest('http://localhost/api/settings', {
        method: 'PATCH',
        headers: {
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': String(LOGO_MAX_BYTES * 3 + 64 * 1024 + 1025),
        },
        body: 'x',
      });
      const res = await patchSettings(req, undefined as never);
      expect(res.status).toBe(413);
    });
  });
});
