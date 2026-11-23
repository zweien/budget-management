'use client';

import * as React from 'react';
import { useState } from 'react';
import { toast } from 'sonner';

import { saveSystemSettingsJson } from '@/lib/api/systemSettings';
import {
  LEDGER_BASIS_LABELS,
  LEDGER_BASIS_VALUES,
  LEDGER_YEAR_LABELS,
  LEDGER_YEAR_VALUES,
  type LedgerBasis,
  type LedgerYearMode,
} from '@/lib/system-settings';
import { isValidDashThresholds, type DashThresholds } from '@/lib/ui-prefs';
import { useUnsavedChangesGuard } from '@/lib/hooks/use-unsaved-changes-guard';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  FieldGroupTitle,
  SelectField,
  SettingsCard,
  type SettingsCardProps,
} from '@/components/settings/settings-fields';

/** 文本框 → 合法分级线;空串或越界返回 null(取值域与个人偏好 cookie 一致)。 */
function parseThresholdInput(warn: string, danger: string): DashThresholds | null {
  const toInt = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));
  const candidate = { warn: toInt(warn), danger: toInt(danger) };
  return isValidDashThresholds(candidate) ? candidate : null;
}

function ThresholdInput({
  label,
  value,
  onChange,
  invalid,
  describedBy,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  invalid: boolean;
  describedBy: string;
}) {
  const id = React.useId();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="w-24 text-right"
        />
        <span className="text-sm text-muted-foreground">%</span>
      </div>
    </div>
  );
}

/** 台账与工作台卡片:台账默认口径/年度、执行率分级线默认值、侧边栏默认折叠。 */
export function WorkspaceCard({ saved, onSaved }: SettingsCardProps) {
  const [basis, setBasis] = useState<LedgerBasis>(saved.ledgerBasis);
  const [yearMode, setYearMode] = useState<LedgerYearMode>(saved.ledgerYear);
  const savedWarn = String(saved.dashThresholds.warn);
  const savedDanger = String(saved.dashThresholds.danger);
  const [warn, setWarn] = useState(savedWarn);
  const [danger, setDanger] = useState(savedDanger);
  const [collapsed, setCollapsed] = useState(saved.sidebarCollapsed);
  const [saving, setSaving] = useState(false);
  const thresholdHintId = React.useId();

  const thresholds = parseThresholdInput(warn, danger);
  const thresholdsTouched = warn !== savedWarn || danger !== savedDanger;
  const dirty =
    basis !== saved.ledgerBasis ||
    yearMode !== saved.ledgerYear ||
    thresholdsTouched ||
    collapsed !== saved.sidebarCollapsed;
  useUnsavedChangesGuard(dirty);

  const handleSave = async () => {
    if (!thresholds) {
      toast.error('执行率分级线须为 0~100 的整数,且预警线小于达标线');
      return;
    }
    setSaving(true);
    try {
      const next = await saveSystemSettingsJson({
        ledgerBasis: basis,
        ledgerYear: yearMode,
        dashThresholds: thresholds,
        sidebarCollapsed: collapsed,
      });
      setBasis(next.ledgerBasis);
      setYearMode(next.ledgerYear);
      setWarn(String(next.dashThresholds.warn));
      setDanger(String(next.dashThresholds.danger));
      setCollapsed(next.sidebarCollapsed);
      onSaved(next);
      toast.success('已保存;其他页面在刷新或跳转后生效');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="台账与工作台"
      description="进页时的默认值。个人在浏览器里调过的分级线与折叠状态仍优先于这里。"
      dirty={dirty}
      saving={saving}
      saveDisabled={!thresholds}
      onSave={() => void handleSave()}
      onReset={() => {
        setBasis(saved.ledgerBasis);
        setYearMode(saved.ledgerYear);
        setWarn(savedWarn);
        setDanger(savedDanger);
        setCollapsed(saved.sidebarCollapsed);
      }}
    >
      <div className="space-y-4">
        <FieldGroupTitle>执行台账</FieldGroupTitle>
        <SelectField<LedgerBasis>
          label="台账默认口径"
          value={basis}
          onChange={setBasis}
          options={LEDGER_BASIS_VALUES.map((value) => ({
            value,
            label: LEDGER_BASIS_LABELS[value],
          }))}
          hint="每次进入项目的执行台账页时初始选中的口径;个人切换只对当次有效。"
        />
        <SelectField<LedgerYearMode>
          label="台账默认年度"
          value={yearMode}
          onChange={setYearMode}
          options={LEDGER_YEAR_VALUES.map((value) => ({
            value,
            label: LEDGER_YEAR_LABELS[value],
          }))}
          hint="「最近有预算的年度」取该项目不晚于今年、且科目预算现行金额不为 0 的最近一年,没有则回到当前年度;年度下拉会一并纳入该项目有预算的年份。"
        />
      </div>
      <div className="space-y-3">
        <FieldGroupTitle>工作台</FieldGroupTitle>
        <div className="space-y-3 rounded-md border border-border p-4">
          <div className="flex flex-wrap items-end gap-6">
            <ThresholdInput
              label="预警线"
              value={warn}
              onChange={setWarn}
              invalid={!thresholds && thresholdsTouched}
              describedBy={thresholdHintId}
            />
            <ThresholdInput
              label="达标线"
              value={danger}
              onChange={setDanger}
              invalid={!thresholds && thresholdsTouched}
              describedBy={thresholdHintId}
            />
          </div>
          <p id={thresholdHintId} className="text-xs text-mute">
            执行率低于预警线为预警色,介于两线之间为警示色,高于达标线为正常色;仅影响着色。
            工作台里的「恢复默认」会清除个人偏好、回到这里的值。
          </p>
          <div className="flex items-start justify-between gap-4 border-t border-border pt-3">
            <div className="grid gap-1">
              <Label htmlFor={thresholdHintId + '-collapsed'}>侧边栏默认折叠</Label>
              <p className="text-xs text-mute">
                没有自己点过折叠开关的浏览器,进站时侧边栏收成窄栏(仅图标)。
              </p>
            </div>
            <Switch
              id={thresholdHintId + '-collapsed'}
              checked={collapsed}
              onCheckedChange={setCollapsed}
            />
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}
