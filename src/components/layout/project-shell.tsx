'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { apiFetch } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

interface ProjectMeta {
  id: string;
  code: string;
  name: string;
}

const TABS = [
  { segment: '', label: '概览' },
  { segment: 'initial-budget', label: '年初预算' },
  { segment: 'records', label: '业务记录' },
  { segment: 'adjustments', label: '预算调整' },
  { segment: 'ledger', label: '执行台账' },
  { segment: 'receipts', label: '到账流水' },
  { segment: 'imports', label: 'Excel 导入' },
] as const;

/**
 * 项目上下文壳(IA 重构):项目名/编号 + 持久 Tab 子导航。
 * URL 即状态,无全局"当前项目";子页不再各自渲染项目名标题。
 */
export function ProjectShell({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const projectId = params.id;

  const [project, setProject] = React.useState<ProjectMeta | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectMeta>(`/api/projects/${projectId}`)
      .then((p) => {
        if (!cancelled) setProject(p);
      })
      .catch(() => {
        // 403/404 由子页自身错误态呈现;壳只隐藏项目名。
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const base = `/projects/${projectId}`;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/projects"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronLeft className="size-4" />
          项目列表
        </Link>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {project ? (
            <>
              <h1 className="text-display-sm">{project.name}</h1>
              <span className="font-mono text-xs text-mute">{project.code}</span>
            </>
          ) : failed ? (
            <h1 className="text-display-sm text-muted-foreground">项目详情</h1>
          ) : (
            <Skeleton className="h-7 w-56" />
          )}
        </div>
        <nav aria-label="项目内导航" className="flex gap-1 overflow-x-auto border-b border-border">
          {TABS.map(({ segment, label }) => {
            const href = segment ? `${base}/${segment}` : base;
            const active = segment
              ? pathname.startsWith(href)
              : pathname === base || pathname === `${base}/`;
            return (
              <Link
                key={segment}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative -mb-px inline-flex items-center border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  active
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
      {children}
    </div>
  );
}
