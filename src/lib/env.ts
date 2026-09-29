import { z } from 'zod';

const envSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    APP_PORT: z.coerce.number().default(3000),
    /** Prisma 连接池上限(拼进 DATABASE_URL 的 connection_limit;URL 已带该参数时不覆盖)。 */
    DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),
    /** true=本地 mock 鉴权(开发/测试);false=Authentik SSO。 */
    MOCK_AUTH: z
      .string()
      .transform((v) => v === 'true')
      .default('true'),
    /** SSO 配置:MOCK_AUTH=false 时必填(见下方 superRefine)。 */
    AUTHENTIK_ISSUER: z.string().url().optional(),
    AUTHENTIK_CLIENT_ID: z.string().min(1).optional(),
    AUTHENTIK_CLIENT_SECRET: z.string().min(1).optional(),
    /** 会话 JWT(HS256)签名密钥:openssl rand -base64 32。 */
    AUTH_SECRET: z.string().min(32).optional(),
    /** 对外基础 URL,用于拼 OIDC redirect_uri / 登出回跳。 */
    APP_BASE_URL: z.string().url().default('http://localhost:3000'),
    /** 附件单文件大小上限(字节,默认 50MB)。 */
    MAX_ATTACHMENT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
    /** 导入文件大小上限(字节,默认 10MB;xlsx 即 zip,须防解压爆炸与 OOM)。 */
    MAX_IMPORT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    /** 导入数据行数上限(默认 2000;确认事务的最坏耗时随行数线性可控)。 */
    MAX_IMPORT_ROWS: z.coerce.number().int().positive().default(2000),
    /** JSON 请求体上限(字节,默认 1MB;授权在服务层执行,须限制预授权缓冲)。 */
    MAX_BODY_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
    /** 附件批量导出字节上限(字节,默认 512MB;zip 全量内存物化,峰值约 2×)。 */
    MAX_EXPORT_TOTAL_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(512 * 1024 * 1024),
    /** 统计自定义导出行数上限(默认 100000;超限 413 提示加筛选)。 */
    MAX_EXPORT_ROWS: z.coerce.number().int().positive().default(100_000),
  })
  .superRefine((data, ctx) => {
    if (data.MOCK_AUTH) return;
    // SSO 模式下四个变量缺一不可,否则启动即失败(fail fast,避免运行期才暴露)。
    const required = [
      'AUTHENTIK_ISSUER',
      'AUTHENTIK_CLIENT_ID',
      'AUTHENTIK_CLIENT_SECRET',
      'AUTH_SECRET',
    ] as const;
    for (const key of required) {
      if (!data[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: `MOCK_AUTH=false 时必填 ${key}` });
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment variables. See errors above.');
}

export const env = parsed.data;
