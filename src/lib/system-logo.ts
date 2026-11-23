/**
 * 系统标志校验(纯函数,无 IO/无 DB,便于单测;与 attachments/config.ts 同款返回形态)。
 * 类型按文件内容识别(不信客户端 MIME),并给位图设像素上限。
 */

/** 单个标志文件大小上限:标志展示宽度 ≤ 140px,512KB 足够容纳 3 倍图。 */
export const LOGO_MAX_BYTES = 512 * 1024;

/** 位图像素上限:防「解压炸弹」——纯色大画布能压进几 KB,浏览器解码却按像素占内存。 */
export const LOGO_MAX_DIMENSION = 4096;

export type LogoType = 'image/png' | 'image/webp' | 'image/svg+xml';

export type LogoValidation =
  { ok: true; contentType: LogoType } | { ok: false; status: number; message: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((b, i) => bytes[i] === b);
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * SVG 禁止内容:脚本、事件属性、可嵌入外部文档的元素、外部引用。
 * 这只是纵深防御——真正的边界是响应头上的 CSP(标志路由对 SVG 下发
 * `default-src 'none'; sandbox`),直接打开该地址也不会执行任何脚本。
 * 正则宁可误伤(标志文件里不该出现这些写法),不放行可疑内容。
 */
const SVG_FORBIDDEN: Array<[RegExp, string]> = [
  [/<\s*(script|foreignobject|iframe|object|embed)\b/i, '脚本或可嵌入外部内容的元素'],
  [/\son[a-z]+\s*=/i, '事件处理属性'],
  [/javascript:/i, 'javascript: 地址'],
  [/\b(?:xlink:)?href\s*=\s*(["'])(?!(?:#|data:))[^"']*\1/i, '外部引用'],
  [/url\(\s*["']?\s*(?:https?:|\/\/)/i, '外部样式引用'],
  [/@import/i, '外部样式导入'],
];

function svgText(bytes: Uint8Array): string | null {
  // 二进制内容(含 NUL)不当作文本解析。
  const limit = Math.min(bytes.length, 4096);
  if (bytes.subarray(0, limit).includes(0)) return null;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // 去掉 BOM 后,XML 声明(若有)之后只允许空白 / 注释 / doctype / 处理指令,随后必须紧跟根元素
  // <svg>(XML 允许这几样任意穿插;根不是 <svg> 的文档——如内嵌 svg 的 HTML——不算 SVG)。
  const head = text.replace(/^\uFEFF/, '');
  const isSvgDocument =
    /^\s*(?:<\?xml[^>]*\?>\s*)?(?:\s+|<!--[\s\S]*?-->|<!doctype[^>]*>|<\?[^>]*\?>)*<svg[\s>]/i.test(
      head,
    );
  if (!isSvgDocument) return null;
  return text;
}

/** 读位图像素尺寸;非 PNG/WebP 或头部损坏返回 null。 */
export function readRasterSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (startsWith(bytes, PNG_SIGNATURE)) {
    // 签名(8) + 长度(4) + 'IHDR'(4) + 宽(4) + 高(4)
    if (bytes.length < 24 || asciiAt(bytes, 12, 4) !== 'IHDR') return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') {
    const chunk = asciiAt(bytes, 12, 4);
    if (chunk === 'VP8X') {
      // 画布宽高各 24 位小端,存的是「实际值 − 1」。
      if (bytes.length < 30) return null;
      const u24 = (o: number) => bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16);
      return { width: u24(24) + 1, height: u24(27) + 1 };
    }
    if (chunk === 'VP8L') {
      // 签名字节 0x2f 之后:14 位宽 − 1、14 位高 − 1。
      if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ') {
      // 帧标签(3) + 起始码(3) 之后是 14 位宽、14 位高(小端)。
      if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
        return null;
      }
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    return null;
  }
  return null;
}

/** 按文件内容识别标志类型;识别不出返回 null。 */
export function detectLogoType(bytes: Uint8Array): LogoType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'image/webp';
  try {
    if (svgText(bytes) !== null) return 'image/svg+xml';
  } catch {
    // 非法 UTF-8:不是 SVG。
  }
  return null;
}

/** 校验一个标志文件:大小、真实类型、位图像素上限、SVG 禁止内容。 */
export function validateLogo(bytes: Uint8Array): LogoValidation {
  if (bytes.byteLength === 0) {
    return { ok: false, status: 400, message: '标志文件为空' };
  }
  if (bytes.byteLength > LOGO_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      message: `标志文件过大(上限 ${LOGO_MAX_BYTES / 1024} KB)`,
    };
  }
  const type = detectLogoType(bytes);
  if (!type) {
    return {
      ok: false,
      status: 415,
      message: '标志仅支持 PNG / WebP / SVG(按文件内容识别),请确认文件未损坏',
    };
  }
  if (type === 'image/svg+xml') {
    const text = svgText(bytes) ?? '';
    const hit = SVG_FORBIDDEN.find(([re]) => re.test(text));
    if (hit) {
      return {
        ok: false,
        status: 400,
        message: `SVG 含不允许的内容(${hit[1]}),请导出为纯图形的 SVG 或改用 PNG`,
      };
    }
    return { ok: true, contentType: type };
  }
  const size = readRasterSize(bytes);
  if (!size) {
    return { ok: false, status: 400, message: '图片文件损坏或不是有效的 PNG / WebP' };
  }
  if (size.width > LOGO_MAX_DIMENSION || size.height > LOGO_MAX_DIMENSION) {
    return {
      ok: false,
      status: 413,
      message: `图片尺寸过大(${size.width}×${size.height},上限 ${LOGO_MAX_DIMENSION}×${LOGO_MAX_DIMENSION} 像素)`,
    };
  }
  return { ok: true, contentType: type };
}
