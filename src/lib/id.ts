import { v7 as uuidv7base } from 'uuid';

/** 生成时间有序的 UUID v7,作为所有表主键 */
export function uuidv7(): string {
  return uuidv7base();
}
