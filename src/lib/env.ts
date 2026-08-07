import { z } from 'zod';

const envSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    APP_PORT: z.coerce.number().default(3000),
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
