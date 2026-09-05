import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

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
    return { status: e.status, message: e.message };
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
