/**
 * 测试用标志文件样本:按文件头手工构造(校验只看文件头),不依赖真实编码器。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG:签名 + IHDR(宽高可控)+ CRC 占位;pad 追加零字节以撑大文件体积。 */
export function pngBytes(width: number, height: number, pad = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 RGBA
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const crc = Buffer.alloc(4);
  return Buffer.concat([PNG_SIGNATURE, length, Buffer.from('IHDR'), ihdr, crc, Buffer.alloc(pad)]);
}

function riff(chunk: string, payload: Buffer): Buffer {
  const fileSize = Buffer.alloc(4);
  fileSize.writeUInt32LE(4 + 8 + payload.length, 0);
  const chunkSize = Buffer.alloc(4);
  chunkSize.writeUInt32LE(payload.length, 0);
  return Buffer.concat([
    Buffer.from('RIFF'),
    fileSize,
    Buffer.from('WEBP'),
    Buffer.from(chunk),
    chunkSize,
    payload,
  ]);
}

function u24le(target: Buffer, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
  target[offset + 2] = (value >> 16) & 0xff;
}

/** WebP 扩展格式(VP8X):画布宽高各 24 位小端,存「实际值 − 1」。 */
export function webpVp8x(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  u24le(payload, 4, width - 1);
  u24le(payload, 7, height - 1);
  return riff('VP8X', payload);
}

/** WebP 无损(VP8L):签名字节 0x2f 之后 14 位宽 − 1、14 位高 − 1(小端位域)。 */
export function webpVp8l(width: number, height: number): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE(((height - 1) << 14) | (width - 1), 1);
  return riff('VP8L', payload);
}

/** WebP 有损(VP8 ):帧标签(3)+ 起始码 9d 01 2a(3)+ 14 位宽、高(小端)。 */
export function webpVp8(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10);
  payload[3] = 0x9d;
  payload[4] = 0x01;
  payload[5] = 0x2a;
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return riff('VP8 ', payload);
}

/** 最小合法 SVG。 */
export function svgBytes(body = '<circle cx="4" cy="4" r="4"/>'): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${body}</svg>`,
    'utf8',
  );
}
