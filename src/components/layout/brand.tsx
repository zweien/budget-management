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
