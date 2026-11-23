'use client';

import * as React from 'react';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import {
  LOGO_SLOTS,
  LOGO_SLOT_LABELS,
  resolveLogoSrc,
  type LogoMap,
  type LogoSlot,
} from '@/lib/system-settings';
import { LOGO_MAX_BYTES, LOGO_MAX_DIMENSION, validateLogo } from '@/lib/system-logo';
import { Brand, SystemLogoImage } from '@/components/layout/brand';
import { Button } from '@/components/ui/button';

/** 标志位的待保存动作:保存前只存在于品牌卡片内,预览用本地 object URL。 */
export type LogoDraft = { kind: 'file'; file: File; previewUrl: string } | { kind: 'clear' };
export type LogoDrafts = Partial<Record<LogoSlot, LogoDraft>>;

const SLOT_HINTS: Record<LogoSlot, string> = {
  standard: '必选。浅色主题下的侧边栏顶部与登录页使用它;清除即恢复内置品牌标志。',
  dark: '可选。深色主题下使用;未设置时深色主题也用标准版。',
  compact: '可选。侧边栏收成窄栏时使用;未设置时把当前主题的版本整体缩小。',
};

const PREVIEW_TILES = [
  { dark: false, compact: false, label: '浅色 · 展开' },
  { dark: true, compact: false, label: '深色 · 展开' },
  { dark: false, compact: true, label: '浅色 · 窄栏' },
  { dark: true, compact: true, label: '深色 · 窄栏' },
] as const;

function LogoSlotRow({
  slot,
  src,
  draft,
  locked,
  onChange,
}: {
  slot: LogoSlot;
  /** 当前生效的预览来源(待保存文件 > 已保存标志 > null = 内置)。 */
  src: string | null;
  draft: LogoDraft | undefined;
  /** 深色版/窄栏图标版依附标准版:没有标准版时不可设置。 */
  locked: boolean;
  onChange: (next: LogoDraft | null) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 清空选择:同一个文件重选也能再次触发 change。
    e.target.value = '';
    if (!file) return;
    // 与服务端同一套校验,先在本地给出即时反馈(服务端仍会全量重验)。
    const check = validateLogo(new Uint8Array(await file.arrayBuffer()));
    if (!check.ok) {
      toast.error(`${LOGO_SLOT_LABELS[slot]}:${check.message}`);
      return;
    }
    onChange({ kind: 'file', file, previewUrl: URL.createObjectURL(file) });
  };

  const clearing = draft?.kind === 'clear';

  return (
    // 三段网格(缩略图 / 说明 / 操作):宽屏一行三列;窄屏自然堆叠。不用 flex-wrap——
    // 说明块带 flex-1 时会先被压到一两个字符宽而不是换行,手机上每行被撑成一条竖排文字。
    <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-center">
      <span className="grid h-12 w-28 place-items-center overflow-hidden rounded-md border border-border bg-muted/40">
        {clearing ? (
          <span className="text-xs text-mute">保存后清除</span>
        ) : src ? (
          // eslint-disable-next-line @next/next/no-img-element -- 待保存标志是本地 object URL,且带版本号的已保存标志无需图片优化
          <img src={src} alt="" className="h-full w-full object-contain p-1" />
        ) : (
          <span className="text-xs text-mute">内置标志</span>
        )}
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{LOGO_SLOT_LABELS[slot]}</p>
        <p className="text-xs text-muted-foreground">{SLOT_HINTS[slot]}</p>
        {locked ? <p className="text-xs text-mute">先设置标准版后可用。</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".png,.webp,.svg"
          className="hidden"
          disabled={locked}
          onChange={(e) => {
            void handlePick(e);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={locked}
          onClick={() => inputRef.current?.click()}
        >
          <Upload />
          {draft?.kind === 'file' ? '重新选择' : '选择文件'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!src && !clearing}
          onClick={() => onChange(clearing ? null : { kind: 'clear' })}
        >
          {clearing ? '撤销清除' : '清除'}
        </Button>
      </div>
    </div>
  );
}

/**
 * 系统标志编辑:三个上传位 + 「浅色/深色 × 展开/窄栏」即时预览。
 * 预览直接复用正式渲染组件与真实的主题切换规则(data-theme / .dark),所见即所得。
 */
export function LogoEditor({
  savedLogos,
  drafts,
  onChange,
}: {
  savedLogos: LogoMap;
  drafts: LogoDrafts;
  onChange: (slot: LogoSlot, next: LogoDraft | null) => void;
}) {
  const effective = (slot: LogoSlot): string | null => {
    const draft = drafts[slot];
    if (draft?.kind === 'file') return draft.previewUrl;
    if (draft?.kind === 'clear') return null;
    return savedLogos[slot]?.url ?? null;
  };
  const previewLogos: Record<LogoSlot, string | null> = {
    standard: effective('standard'),
    dark: effective('dark'),
    compact: effective('compact'),
  };
  const standardSet = previewLogos.standard !== null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3">
        {LOGO_SLOTS.map((slot) => (
          <LogoSlotRow
            key={slot}
            slot={slot}
            src={effective(slot)}
            draft={drafts[slot]}
            locked={slot !== 'standard' && !standardSet}
            onChange={(next) => onChange(slot, next)}
          />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {PREVIEW_TILES.map((tile) => {
          const src = resolveLogoSrc(previewLogos, { compact: tile.compact, dark: tile.dark });
          return (
            <div key={tile.label} className="grid gap-1.5">
              <p className="text-xs text-mute">{tile.label}</p>
              {/* 深色预览块就地套用 .dark / data-theme=dark:块内按真实的深色主题令牌与标志显隐规则渲染 */}
              <div
                className={cn(
                  'flex h-20 items-center rounded-md border border-border bg-background px-4',
                  tile.dark && 'dark',
                )}
                data-theme={tile.dark ? 'dark' : 'light'}
              >
                <span className={cn('flex justify-center', tile.compact ? 'w-12' : 'flex-1')}>
                  {src ? (
                    <SystemLogoImage
                      light={src}
                      dark={src}
                      alt=""
                      className={
                        tile.compact ? 'brand-symbol' : 'max-h-9 max-w-[140px] object-contain'
                      }
                    />
                  ) : (
                    <Brand compact={tile.compact} />
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-mute">
        PNG / WebP / SVG,单个不超过 {LOGO_MAX_BYTES / 1024} KB;位图像素上限 {LOGO_MAX_DIMENSION}×
        {LOGO_MAX_DIMENSION}。SVG 不允许含脚本、事件属性或外部引用。
      </p>
    </div>
  );
}
