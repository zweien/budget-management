'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { saveSystemSettingsJson } from '@/lib/api/systemSettings';
import { THEME_LABELS, THEME_VALUES, type ThemeValue } from '@/lib/system-settings';
import { useUnsavedChangesGuard } from '@/lib/hooks/use-unsaved-changes-guard';
import {
  SelectField,
  SettingsCard,
  type SettingsCardProps,
} from '@/components/settings/settings-fields';

/** 外观卡片:默认主题。 */
export function AppearanceCard({ saved, onSaved }: SettingsCardProps) {
  const [theme, setTheme] = useState<ThemeValue>(saved.defaultTheme);
  const [saving, setSaving] = useState(false);
  const dirty = theme !== saved.defaultTheme;
  useUnsavedChangesGuard(dirty);

  const handleSave = async () => {
    setSaving(true);
    try {
      const next = await saveSystemSettingsJson({ defaultTheme: theme });
      setTheme(next.defaultTheme);
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
      title="外观"
      description="新访问的浏览器首次打开时使用的主题。"
      dirty={dirty}
      saving={saving}
      onSave={() => void handleSave()}
      onReset={() => setTheme(saved.defaultTheme)}
    >
      <SelectField<ThemeValue>
        label="默认主题"
        value={theme}
        onChange={setTheme}
        options={THEME_VALUES.map((value) => ({ value, label: THEME_LABELS[value] }))}
        hint="只在某人没有自己切换过主题时起作用:个人点过顶栏的亮/暗切换后,一直按其个人选择显示。"
      />
    </SettingsCard>
  );
}
