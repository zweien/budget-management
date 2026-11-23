import { assertContentLengthBelow } from '@/lib/api/withRoute';
import { HTTPError } from '@/lib/auth/session';
import { LOGO_SLOTS, type LogoSlot } from '@/lib/system-settings';
import { LOGO_MAX_BYTES } from '@/lib/system-logo';
import type { LogoOperations } from '@/server/services/systemSetting.service';

/**
 * 系统设置保存端点的 multipart 解析(非路由):品牌卡片一次提交文本字段 + 标志文件。
 */

/** multipart 总量上限:三个标志位各一个上限文件,外加文本字段与编码开销的余量。 */
export const SETTINGS_FORM_CAP = LOGO_MAX_BYTES * LOGO_SLOTS.length + 64 * 1024;

const LOGO_FIELD = /^logo\[(standard|dark|compact)\]$/;

export interface SettingsForm {
  /** 标量键的原始值(字符串;类型与取值交服务层按字段校验)。 */
  patch: Record<string, unknown>;
  logoOps: LogoOperations;
}

/**
 * 解析设置表单:`logo[standard|dark|compact]` 为文件 = 设置该标志位,
 * 为字符串 "clear" = 清除该位;其余字段一律按文本原样交给服务层。
 */
export async function readSettingsForm(req: Request): Promise<SettingsForm> {
  // formData() 会整体缓冲后才轮到应用层校验:先用声明长度切断明显超限的请求(与导入上传同款)。
  assertContentLengthBelow(req, SETTINGS_FORM_CAP);
  const form = await req.formData();
  const patch: Record<string, unknown> = {};
  const logoOps: LogoOperations = {};
  for (const [name, value] of form.entries()) {
    const logoField = LOGO_FIELD.exec(name);
    if (logoField) {
      const slot = logoField[1] as LogoSlot;
      if (value instanceof File) {
        logoOps[slot] = { action: 'set', bytes: Buffer.from(await value.arrayBuffer()) };
      } else if (value === 'clear') {
        logoOps[slot] = { action: 'clear' };
      } else {
        throw new HTTPError(400, `标志字段 ${name} 取值无效`);
      }
      continue;
    }
    if (typeof value !== 'string') {
      throw new HTTPError(400, `字段 ${name} 应为文本`);
    }
    patch[name] = value;
  }
  return { patch, logoOps };
}
