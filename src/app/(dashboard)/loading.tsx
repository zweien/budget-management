import { Skeleton } from '@/components/ui/skeleton';

/** 路由段加载骨架:消除「旧页停留 → 白屏 → 页内骨架」三段式过渡的中间白屏。 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    </div>
  );
}
