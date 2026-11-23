import { cn } from '@/lib/utils';

/**
 * IDRL 品牌节点(移植自 idrl-vi src/components/brand.tsx):
 * 浅/深两套 SVG 均渲染,由 globals.css 按 data-theme 切换显示;
 * 深底用官方 reverse 版本,不做滤镜。资产:public/brand/logo/(OFL/品牌授权见 idrl-adoption)。
 */
export function Brand({ compact = false, className }: { compact?: boolean; className?: string }) {
  const lightSrc = compact ? '/brand/logo/symbol-color.svg' : '/brand/logo/lockup-idrl.svg';
  const darkSrc = compact
    ? '/brand/logo/symbol-color-reverse.svg'
    : '/brand/logo/lockup-idrl-reverse.svg';
  const klass = cn(compact ? 'brand-symbol' : 'brand-wordmark', className);
  const alt = compact ? 'IDRL' : 'IDRL · Intelligent Design and Robust Learning';
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- 品牌 SVG 需双份常驻以按主题切换 */}
      <img className={cn(klass, 'brand-theme-light')} src={lightSrc} alt={alt} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={cn(klass, 'brand-theme-dark')} src={darkSrc} alt="" aria-hidden="true" />
    </>
  );
}

/**
 * 自定义系统标志的图片对(来源由调用方按回退规则解析,见 system-settings 的 resolveLogoSrc)。
 * 浅/深来源不同时沿用 data-theme 显隐;相同时只渲染一张,不留空图占位。
 * 尺寸由调用方的 className 决定(侧边栏字标位 / 窄栏 symbol 位 / 登录页)。
 */
export function SystemLogoImage({
  light,
  dark,
  alt,
  className,
}: {
  light: string | null;
  dark: string | null;
  alt: string;
  className?: string;
}) {
  const src = light ?? dark;
  if (!src) return null;
  if (light && dark && light !== dark) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element -- 自定义标志需双份常驻以按主题切换 */}
        <img className={cn('brand-theme-light', className)} src={light} alt={alt} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={cn('brand-theme-dark', className)} src={dark} alt="" aria-hidden="true" />
      </>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- 地址带版本号,无需 next/image 的图片优化
  return <img className={className} src={src} alt={alt} />;
}
