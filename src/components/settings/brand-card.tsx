'use client';

import * as React from 'react';
import { useState } from 'react';
import { toast } from 'sonner';

import { saveSystemSettingsForm } from '@/lib/api/systemSettings';
import { LOGO_SLOTS, type LogoSlot } from '@/lib/system-settings';
import { useUnsavedChangesGuard } from '@/lib/hooks/use-unsaved-changes-guard';
import { LogoEditor, type LogoDraft, type LogoDrafts } from '@/components/settings/logo-editor';
import {
  FieldGroupTitle,
  SettingsCard,
  TextField,
  type SettingsCardProps,
} from '@/components/settings/settings-fields';

const SAVED_TOAST = '已保存;其他页面在刷新或跳转后生效';

/**
 * 品牌与信息卡片:标题、副标题、登录页提示、关于页简介、页脚文字与系统标志。
 * 一次 multipart 提交,标量与标志同事务生效——不会出现「标志换了、标题没换」的半截状态。
 */
export function BrandCard({ saved, onSaved }: SettingsCardProps) {
  const [title, setTitle] = useState(saved.title);
  const [subtitle, setSubtitle] = useState(saved.subtitle ?? '');
  const [loginNotice, setLoginNotice] = useState(saved.loginNotice ?? '');
  const [aboutIntro, setAboutIntro] = useState(saved.aboutIntro ?? '');
  const [footerText, setFooterText] = useState(saved.footerText ?? '');
  const [logoDrafts, setLogoDrafts] = useState<LogoDrafts>({});
  const [saving, setSaving] = useState(false);
  // 本卡片创建的 object URL:替换/放弃/保存/卸载时回收。
  const objectUrls = React.useRef(new Set<string>());

  React.useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  const dirty =
    title !== saved.title ||
    subtitle !== (saved.subtitle ?? '') ||
    loginNotice !== (saved.loginNotice ?? '') ||
    aboutIntro !== (saved.aboutIntro ?? '') ||
    footerText !== (saved.footerText ?? '') ||
    LOGO_SLOTS.some((slot) => logoDrafts[slot] !== undefined);
  useUnsavedChangesGuard(dirty);

  const setLogoDraft = (slot: LogoSlot, next: LogoDraft | null) => {
    const prev = logoDrafts[slot];
    if (prev?.kind === 'file') {
      URL.revokeObjectURL(prev.previewUrl);
      objectUrls.current.delete(prev.previewUrl);
    }
    if (next?.kind === 'file') objectUrls.current.add(next.previewUrl);
    setLogoDrafts((current) => {
      const nextDrafts = { ...current };
      if (next) nextDrafts[slot] = next;
      else delete nextDrafts[slot];
      return nextDrafts;
    });
  };

  /** 以服务端返回的生效值重置本卡片(保存成功/放弃修改后基线与表单一致)。 */
  const resetLogoDrafts = () => {
    for (const slot of LOGO_SLOTS) setLogoDraft(slot, null);
  };

  const handleReset = () => {
    setTitle(saved.title);
    setSubtitle(saved.subtitle ?? '');
    setLoginNotice(saved.loginNotice ?? '');
    setAboutIntro(saved.aboutIntro ?? '');
    setFooterText(saved.footerText ?? '');
    resetLogoDrafts();
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const form = new FormData();
      form.append('title', title);
      form.append('subtitle', subtitle);
      form.append('loginNotice', loginNotice);
      form.append('aboutIntro', aboutIntro);
      form.append('footerText', footerText);
      for (const slot of LOGO_SLOTS) {
        const draft = logoDrafts[slot];
        if (!draft) continue;
        if (draft.kind === 'file') form.append(`logo[${slot}]`, draft.file);
        else form.append(`logo[${slot}]`, 'clear');
      }
      const next = await saveSystemSettingsForm(form);
      resetLogoDrafts();
      setTitle(next.title);
      setSubtitle(next.subtitle ?? '');
      setLoginNotice(next.loginNotice ?? '');
      setAboutIntro(next.aboutIntro ?? '');
      setFooterText(next.footerText ?? '');
      onSaved(next);
      toast.success(SAVED_TOAST);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      title="品牌与信息"
      description="系统标题与标志,以及登录页、关于页与页脚展示的文字。"
      dirty={dirty}
      saving={saving}
      onSave={() => void handleSave()}
      onReset={handleReset}
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <TextField
            label="系统标题"
            value={title}
            onChange={setTitle}
            maxLength={30}
            placeholder="预算管理系统"
            hint="用于浏览器标签页标题、侧边栏应用名卡片与登录页大标题。"
          />
          <TextField
            label="副标题"
            value={subtitle}
            onChange={setSubtitle}
            maxLength={60}
            placeholder="可留空"
            hint="侧边栏应用名卡片的第二行、「关于」页副标题与页面描述;留空则不显示。"
          />
          <TextField
            label="登录页提示"
            value={loginNotice}
            onChange={setLoginNotice}
            maxLength={200}
            placeholder="可留空"
            hint="登录卡片底部的一行提示;留空则不显示。"
          />
          <TextField
            label="页脚文字"
            value={footerText}
            onChange={setFooterText}
            maxLength={100}
            placeholder="可留空,如单位名称或版权信息"
            hint="显示在侧边栏底部版本号下方(窄栏时隐藏)与登录页最底部;留空则不显示。"
          />
        </div>
        <TextField
          label="关于页系统简介"
          value={aboutIntro}
          onChange={setAboutIntro}
          maxLength={1000}
          multiline
          rows={12}
          placeholder="可留空"
          hint="「关于」页「系统简介」段落,纯文本、保留换行;留空则不显示该段落。"
        />
      </div>
      <div className="space-y-3">
        <FieldGroupTitle>系统标志</FieldGroupTitle>
        <p className="text-xs text-mute">
          替换侧边栏顶部与登录页的品牌标志;未设置的版本回退到标准版,全部清除即恢复内置标志。
          浏览器标签页图标不在其中。
        </p>
        <LogoEditor savedLogos={saved.logos} drafts={logoDrafts} onChange={setLogoDraft} />
      </div>
    </SettingsCard>
  );
}
