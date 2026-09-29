import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

import { env } from '@/lib/env';
import { HTTPError } from '@/lib/auth/session';

/**
 * HTTP 边缘的深模块:一条接缝服务全部 API 路由。
 * 路由 handler 只写业务;本模块统一承担——
 * - 错误分类:HTTPError 透传、Prisma 已知错误翻译(P2002→409/P2025→404/P2028→503)、
 *   Zod→422、JSON 解析→400、其余一律 500 且不向客户端泄漏内部细节;
 * - 请求日志:单行结构化 JSON(requestId/method/path/status/耗时),5xx 走 error 级;
 * - requestId 注入错误响应体,客户端报障可与服务端日志精确关联。
 * 两个适配器证明这个接缝是真的:生产 HTTP 在上,测试直调返回的函数在下。
 */

interface ClassifiedError {
  status: number;
  message: string;
  stack?: string;
}

/** 错误分类:可预期的翻译,不可预期的折叠为 500(细节只进服务端日志)。 */
function classify(e: unknown): ClassifiedError {
  if (e instanceof HTTPError) {
    // 5xx 的 HTTPError 同样是服务端故障:堆栈进日志便于排障;客户端仍只见 message。
    return { status: e.status, message: e.message, stack: e.status >= 500 ? e.stack : undefined };
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2002') {
      const target = Array.isArray(e.meta?.target)
        ? (e.meta.target as string[]).join(', ')
        : undefined;
      return {
        status: 409,
        message: `唯一性冲突${target ? `(${target})` : ''},请检查数据后重试`,
        stack: e.stack,
      };
    }
    if (e.code === 'P2025') {
      return { status: 404, message: '目标记录不存在或已被删除', stack: e.stack };
    }
    if (e.code === 'P2028') {
      return {
        status: 503,
        message: '事务处理超时,请缩小单次操作规模后重试',
        stack: e.stack,
      };
    }
    return { status: 500, message: '数据库操作失败', stack: e.stack };
  }
  if (e instanceof ZodError) {
    const first = e.issues[0];
    return {
      status: 422,
      message: first ? `${first.path.join('.') || '参数'}: ${first.message}` : '参数校验失败',
      stack: e.stack,
    };
  }
  if (e instanceof SyntaxError) {
    return { status: 400, message: '请求体不是有效 JSON', stack: e.stack };
  }
  return {
    status: 500,
    message: '服务器内部错误',
    stack: e instanceof Error ? e.stack : String(e),
  };
}

interface RequestLogInfo {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  error?: string;
  stack?: string;
}

/** 单行结构化请求日志:生产采集只需抓 stdout,一行即一条完整记录。 */
function writeLog(info: RequestLogInfo): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: info.status >= 500 ? 'error' : 'info',
    msg: 'http_request',
    ...info,
  });
  if (info.status >= 500) {
    console.error(line);
  } else {
    console.log(line);
  }
}

/** MIME 长度预检的可读上限文案。 */
function capLabel(cap: number): string {
  return cap % (1024 * 1024) === 0 ? `${Math.floor(cap / 1024 / 1024)}MB` : `${cap} 字节`;
}

/**
 * 带字节上限的 JSON 请求体读取(安全审计 bm1-plat-json-body-nocap):
 * 裸 `req.json()` 会把整个 body 无界缓冲进堆,而授权(requirePermission)在服务层
 * 才执行——最低档凭证也能借此让共享进程预授权缓冲任意大小数据。本助手先做
 * Content-Length 预检,再流式读取并逐块计数,超限即 413,堆上永不出现超过
 * 上限的缓冲。JSON 文法检查仍交给 JSON.parse(SyntaxError → 400,与原
 * `req.json()` 行为一致;空 body 同样以 400 报错)。
 */
export async function readJson<T = unknown>(req: Request, cap = env.MAX_BODY_BYTES): Promise<T> {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap) {
    throw new HTTPError(413, `请求体过大(上限 ${capLabel(cap)})`);
  }
  const reader = req.body?.getReader();
  if (!reader) {
    throw new HTTPError(400, '请求体不是有效 JSON');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new HTTPError(413, `请求体过大(上限 ${capLabel(cap)})`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

/**
 * multipart 请求的长度预检(安全审计 bm1-att-upload-body-buffer-unbounded):
 * `req.formData()` 由运行时整体缓冲后才轮到应用层的文件大小/权限校验,本检查在
 * 缓冲开始前用声明长度(含 multipart 编码开销,留 1KB 余量)切断明显超限的请求。
 * 局限:chunked(无 Content-Length)请求绕过此检查——完整防护需流式解析,部署侧
 * 由反向代理 body 上限兜底(见 docs/security-audit-run1-checklist.md)。
 */
export function assertContentLengthBelow(req: Request, cap: number): void {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > cap + 1024) {
    throw new HTTPError(413, `上传内容过大(上限 ${capLabel(cap)})`);
  }
}

export function withRoute<Ctx>(
  handler: (req: NextRequest, ctx: Ctx) => Promise<Response>,
): (req: NextRequest, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const method = req.method;
    // 兼容 NextRequest 与测试直调时的普通 Request(后者无 nextUrl)。
    const path = new URL(req.url).pathname;
    let res: Response;
    try {
      res = await handler(req, ctx);
    } catch (e) {
      const { status, message, stack } = classify(e);
      writeLog({
        requestId,
        method,
        path,
        status,
        durationMs: Date.now() - startedAt,
        error: message,
        stack,
      });
      return NextResponse.json({ error: message, requestId }, { status });
    }
    writeLog({ requestId, method, path, status: res.status, durationMs: Date.now() - startedAt });
    return res;
  };
}
