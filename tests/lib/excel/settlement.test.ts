import { describe, it, expect } from 'vitest';

import { SETTLEMENT_SKIPPED_STATUS, SETTLEMENT_STATUS_TO_ENUM } from '@/lib/excel/settlement';

/** 单据状态映射表:结算单 v1/v2/v3 共用,财务系统导出的状态必须全量可识别。 */
describe('SETTLEMENT_STATUS_TO_ENUM', () => {
  it('完成记账 → PAID(已支出)', () => {
    expect(SETTLEMENT_STATUS_TO_ENUM['完成记账']).toBe('PAID');
  });

  it('在途单据 → FINANCE_APPROVAL(财务系统审批)', () => {
    const inFlight = [
      '制单保存',
      '打印审签',
      '完成审核',
      '待记账',
      '完成复核',
      '提交审核',
      '完成收单',
    ];
    for (const label of inFlight) {
      expect(SETTLEMENT_STATUS_TO_ENUM[label], label).toBe('FINANCE_APPROVAL');
    }
  });

  it('业务退单不在映射表(解析期整行跳过,不进入状态映射)', () => {
    expect(SETTLEMENT_STATUS_TO_ENUM[SETTLEMENT_SKIPPED_STATUS]).toBeUndefined();
    expect(SETTLEMENT_SKIPPED_STATUS).toBe('业务退单');
  });
});
