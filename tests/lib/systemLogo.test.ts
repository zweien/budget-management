import { describe, it, expect } from 'vitest';

import {
  detectLogoType,
  readRasterSize,
  validateLogo,
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION,
} from '@/lib/system-logo';
import { pngBytes, svgBytes, webpVp8, webpVp8l, webpVp8x } from '../helpers/logo-fixtures';

describe('system-logo validateLogo(纯函数:大小 / 真实类型 / 像素上限 / SVG 禁止内容)', () => {
  it('按文件内容识别类型:PNG / WebP 三种子格式 / SVG(含 XML 声明、注释、doctype)', () => {
    expect(detectLogoType(pngBytes(1, 1))).toBe('image/png');
    expect(detectLogoType(webpVp8x(120, 40))).toBe('image/webp');
    expect(detectLogoType(webpVp8l(120, 40))).toBe('image/webp');
    expect(detectLogoType(webpVp8(120, 40))).toBe('image/webp');
    expect(detectLogoType(svgBytes())).toBe('image/svg+xml');
    expect(
      detectLogoType(
        Buffer.from(
          '\uFEFF<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg xmlns="http://www.w3.org/2000/svg"/>',
        ),
      ),
    ).toBe('image/svg+xml');
  });

  it('SVG 序言里的注释 / doctype / 处理指令可任意穿插;根元素不是 <svg> 的文档不算 SVG', () => {
    const prolog = (middle: string) =>
      Buffer.from(
        `\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n${middle}<svg xmlns="http://www.w3.org/2000/svg"/>`,
        'utf8',
      );
    const doctype = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n';
    const comment = '<!-- 生成的标志文件 -->\n';
    const pi = '<?xml-stylesheet type="text/css" href="#a"?>\n';
    expect(detectLogoType(prolog(`${comment}${doctype}`))).toBe('image/svg+xml');
    expect(detectLogoType(prolog(`${doctype}${comment}`))).toBe('image/svg+xml');
    expect(detectLogoType(prolog(`${comment}${pi}${doctype}${comment}`))).toBe('image/svg+xml');
    expect(detectLogoType(prolog('   \n\t'))).toBe('image/svg+xml');
    // 根元素是 html / 正文里才有 svg:不是 SVG 文档。
    expect(detectLogoType(prolog('').subarray(0, 0))).toBeNull();
    expect(
      detectLogoType(
        Buffer.from(
          '<!DOCTYPE html>\n<html><body><svg xmlns="http://www.w3.org/2000/svg"/></body></html>',
        ),
      ),
    ).toBeNull();
    expect(
      detectLogoType(Buffer.from('logo\n<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
  });

  it('识别不出类型的返回 null:截断的 PNG、普通文本、GIF、含 NUL 的二进制', () => {
    expect(detectLogoType(pngBytes(1, 1).subarray(0, 6))).toBeNull();
    expect(detectLogoType(Buffer.from('hello world'))).toBeNull();
    expect(detectLogoType(Buffer.from('GIF89a\u0000\u0000'))).toBeNull();
    expect(detectLogoType(Buffer.concat([svgBytes(), Buffer.from([0])]))).toBeNull();
  });

  it('读位图尺寸:PNG IHDR / WebP VP8X、VP8L、VP8', () => {
    expect(readRasterSize(pngBytes(640, 480))).toEqual({ width: 640, height: 480 });
    expect(readRasterSize(webpVp8x(300, 200))).toEqual({ width: 300, height: 200 });
    expect(readRasterSize(webpVp8l(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(readRasterSize(webpVp8(800, 600))).toEqual({ width: 800, height: 600 });
    expect(readRasterSize(pngBytes(1, 1).subarray(0, 20))).toBeNull();
  });

  it('合法文件通过,并给出规范化的 Content-Type', () => {
    expect(validateLogo(pngBytes(64, 64))).toEqual({ ok: true, contentType: 'image/png' });
    expect(validateLogo(webpVp8x(64, 64))).toEqual({ ok: true, contentType: 'image/webp' });
    expect(validateLogo(svgBytes())).toEqual({ ok: true, contentType: 'image/svg+xml' });
  });

  it('空文件 400;超过大小上限 413;恰好等于上限通过', () => {
    expect(validateLogo(Buffer.alloc(0))).toMatchObject({ ok: false, status: 400 });
    const head = pngBytes(1, 1).length;
    expect(validateLogo(pngBytes(1, 1, LOGO_MAX_BYTES - head + 1))).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(validateLogo(pngBytes(1, 1, LOGO_MAX_BYTES - head))).toMatchObject({ ok: true });
  });

  it('类型不受支持 415:伪装成图片的文本、GIF、JPEG', () => {
    expect(validateLogo(Buffer.from('not an image at all'))).toMatchObject({
      ok: false,
      status: 415,
    });
    expect(
      validateLogo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])),
    ).toMatchObject({ ok: false, status: 415 });
  });

  it('像素上限:任一边超过上限 413(防小文件大画布的解压炸弹);恰好等于上限通过', () => {
    const over = pngBytes(LOGO_MAX_DIMENSION + 1, 10);
    expect(validateLogo(over)).toMatchObject({ ok: false, status: 413 });
    expect(validateLogo(pngBytes(10, LOGO_MAX_DIMENSION + 1))).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(validateLogo(webpVp8x(LOGO_MAX_DIMENSION + 1, 10))).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(validateLogo(webpVp8l(10, LOGO_MAX_DIMENSION + 1))).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(validateLogo(webpVp8(LOGO_MAX_DIMENSION + 1, 10))).toMatchObject({
      ok: false,
      status: 413,
    });
    expect(validateLogo(pngBytes(LOGO_MAX_DIMENSION, LOGO_MAX_DIMENSION))).toMatchObject({
      ok: true,
    });
  });

  it('头部损坏的位图 400:IHDR 之外的分块、VP8 起始码不对', () => {
    const badPng = pngBytes(4, 4);
    badPng.write('XXXX', 12, 'ascii');
    expect(validateLogo(badPng)).toMatchObject({ ok: false, status: 400 });
    const badVp8 = webpVp8(4, 4);
    badVp8[23] = 0x00;
    expect(validateLogo(badVp8)).toMatchObject({ ok: false, status: 400 });
  });

  it('SVG 含脚本、事件属性、可嵌入外部文档的元素、javascript: 地址一律 400', () => {
    const bodies = [
      '<script>alert(1)</script>',
      '<SCRIPT xmlns="http://www.w3.org/1999/xhtml">alert(1)</SCRIPT>',
      '<g onload="alert(1)"/>',
      '<g ONCLICK = "alert(1)"/>',
      '<a href="javascript:alert(1)"><rect width="8" height="8"/></a>',
      '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject>',
      '<iframe src="https://evil.example"/>',
      '<image href="https://evil.example/x.png"/>',
      '<use xlink:href="//evil.example/x.svg#a"/>',
      '<style>@import url(https://evil.example/a.css);</style>',
      '<rect fill="url(https://evil.example/a.svg#p)"/>',
    ];
    for (const body of bodies) {
      const result = validateLogo(svgBytes(body));
      expect(result, body).toMatchObject({ ok: false, status: 400 });
    }
  });

  it('SVG 的站内引用不受影响(渐变、内部 use、data: 内嵌图)', () => {
    const body =
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient>' +
      '<path id="p" d="M0 0h8v8z"/></defs>' +
      '<rect width="8" height="8" fill="url(#g)"/>' +
      '<use href="#p"/><use xlink:href="#p"/>' +
      '<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>';
    expect(validateLogo(svgBytes(body))).toEqual({ ok: true, contentType: 'image/svg+xml' });
  });
});
