'use client';

import { resolveLogoSrc } from '@/lib/system-settings';
import { Brand, SystemLogoImage } from '@/components/layout/brand';
import { useSystemSettings } from '@/components/layout/system-settings-provider';

/**
 * 侧边栏顶部(与移动端抽屉)的系统标志:有自定义标志时按回退规则取浅/深两套来源
 * (CONTEXT.md「系统标志」);未设置时呈现内置 IDRL 字标(窄栏为符号)。
 * 自定义标志只收窄展示尺寸:className 传展示位的尺寸约束。
 */
export function SystemLogo({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const { logos, title } = useSystemSettings();
  const light = resolveLogoSrc(logos, { compact, dark: false });
  const dark = resolveLogoSrc(logos, { compact, dark: true });
  if (!light && !dark) return <Brand compact={compact} />;
  return <SystemLogoImage light={light} dark={dark} alt={title} className={className} />;
}
