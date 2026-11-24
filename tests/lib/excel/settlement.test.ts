import { describe, it, expect } from 'vitest';

import { SETTLEMENT_STATUS_TO_ENUM, SETTLEMENT_SUPPORTED_STATUS } from '@/lib/excel/settlement';
import { STATUS_CN_TO_ENUM, STATUS_ENUM_TO_CN } from '@/lib/excel/template';
import { statusRewriteAllowed } from '@/server/services/duplicateCheck.service';

/** 单据状态映射表:结算单 v1/v2/v3/v4 共用,财务系统导出的状态必须全量可识别。 */
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

  it('业务退单 → RETURNED(照常入账,不再跳过)', () => {
    expect(SETTLEMENT_STATUS_TO_ENUM['业务退单']).toBe('RETURNED');
  });

  it('无法识别状态的提示清单与映射表同步(含业务退单,无「不导入」字样)', () => {
    expect(SETTLEMENT_SUPPORTED_STATUS.split('/')).toEqual(Object.keys(SETTLEMENT_STATUS_TO_ENUM));
    expect(SETTLEMENT_SUPPORTED_STATUS).toContain('业务退单');
    expect(SETTLEMENT_SUPPORTED_STATUS).not.toContain('不导入');
  });
});

/** 系统标准模板的业务状态映射:五态中文全量可识别、可回显。 */
describe('STATUS_CN_TO_ENUM / STATUS_ENUM_TO_CN', () => {
  it('业务退单 ↔ RETURNED,且与结算单映射到同一枚举值', () => {
    expect(STATUS_CN_TO_ENUM['业务退单']).toBe('RETURNED');
    expect(STATUS_ENUM_TO_CN.RETURNED).toBe('业务退单');
    expect(STATUS_CN_TO_ENUM['业务退单']).toBe(SETTLEMENT_STATUS_TO_ENUM['业务退单']);
  });

  it('中英映射互为反向(每个枚举值都有中文回显)', () => {
    for (const [cn, en] of Object.entries(STATUS_CN_TO_ENUM)) {
      expect(STATUS_ENUM_TO_CN[en], en).toBe(cn);
    }
  });
});

/** 补全更新的状态回写判定:预览(查重)与确认(复核)共用。 */
describe('statusRewriteAllowed', () => {
  it('推进到已支出:任何未支出状态都可推进', () => {
    for (const from of ['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'RETURNED']) {
      expect(statusRewriteAllowed(from, 'PAID'), from).toBe(true);
    }
  });

  it('已支出是终态:不回退到任何状态', () => {
    for (const to of ['PLACEHOLDER', 'CONTRACT', 'FINANCE_APPROVAL', 'RETURNED', 'PAID']) {
      expect(statusRewriteAllowed('PAID', to), to).toBe(false);
    }
  });

  it('在途 ↔ 业务退单:随财务系统状态回写', () => {
    expect(statusRewriteAllowed('FINANCE_APPROVAL', 'RETURNED')).toBe(true);
    expect(statusRewriteAllowed('CONTRACT', 'RETURNED')).toBe(true);
    expect(statusRewriteAllowed('PLACEHOLDER', 'RETURNED')).toBe(true);
    expect(statusRewriteAllowed('RETURNED', 'FINANCE_APPROVAL')).toBe(true);
    expect(statusRewriteAllowed('RETURNED', 'CONTRACT')).toBe(true);
  });

  it('状态未变、或在途态之间互改:不算新信息(仍按硬重复)', () => {
    expect(statusRewriteAllowed('FINANCE_APPROVAL', 'FINANCE_APPROVAL')).toBe(false);
    expect(statusRewriteAllowed('RETURNED', 'RETURNED')).toBe(false);
    expect(statusRewriteAllowed('CONTRACT', 'FINANCE_APPROVAL')).toBe(false);
    expect(statusRewriteAllowed('FINANCE_APPROVAL', 'PLACEHOLDER')).toBe(false);
  });
});
