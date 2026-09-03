'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Download } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch, downloadFile } from '@/lib/api/client';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { BudgetTreeTable, type LedgerNode } from '@/components/ui/BudgetTreeTable';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

interface ProjectLedger {
  year: number;
  nodes: LedgerNode[];
}

/** 生成最近 5 年的年度选项(含当前年,按降序)。 */
function yearOptions(): number[] {
  const now = new Date().getFullYear();
  return [now, now - 1, now - 2, now - 3, now - 4];
}

export default function ProjectLedgerPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  // 口径:annual = 年度视图(预算=该年度科目预算,占用=该年度记录);
  // total = 总预算视图(预算=科目总预算,占用=全部年度记录,无年度维度)。
  const [mode, setMode] = useState<'annual' | 'total'>('annual');
  const [year, setYear] = useState<number>(() => new Date().getFullYear());
  const [ledger, setLedger] = useState<ProjectLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // 拉取台账数据(随口径/年度变化重拉;两个接口都返回扁平 nodes)。
  // loading/error 在切换的事件处理器里重置(事件驱动,非 effect 同步 setState);
  // 此处仅负责发请求并异步落结果。项目名标题由项目壳(ProjectShell)统一承载。
  useEffect(() => {
    let cancelled = false;
    const url =
      mode === 'total'
        ? `/api/projects/${projectId}/ledger-total`
        : `/api/projects/${projectId}/ledger?year=${year}`;
    apiFetch<ProjectLedger>(url)
      .then((l) => {
        if (!cancelled) setLedger(l);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : '加载台账失败';
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, year, mode]);

  /** 口径切换:同步重置在途状态后由上面的 effect 重拉。 */
  const handleModeChange = (next: string) => {
    setLoading(true);
    setError(null);
    setMode(next === 'total' ? 'total' : 'annual');
  };

  /** 年度切换:同步重置在途状态后由上面的 effect 重拉。 */
  const handleYearChange = (next: string) => {
    setLoading(true);
    setError(null);
    setYear(Number(next));
  };

  /** 导出当前年度台账为 xlsx(§10.5;仅年度视图提供)。 */
  const handleExport = async () => {
    setExporting(true);
    try {
      await downloadFile(
        `/api/projects/${projectId}/export/ledger?year=${year}`,
        `ledger-${year}.xlsx`,
      );
      toast.success('已开始下载台账');
    } catch (e: unknown) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid w-40 gap-1.5">
            <Label>口径</Label>
            <Select value={mode} onValueChange={handleModeChange}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="annual">按年度</SelectItem>
                <SelectItem value="total">按总预算(跨年度)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {mode === 'annual' ? (
            <div className="grid w-36 gap-1.5">
              <Label>年度</Label>
              <Select value={String(year)} onValueChange={handleYearChange}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions().map((y) => (
                    <SelectItem key={y} value={String(y)}>
                      {y} 年
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        {mode === 'annual' ? (
          <Button variant="outline" onClick={handleExport} disabled={exporting}>
            <Download />
            {exporting ? '导出中…' : '导出台账'}
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : error ? (
        <Alert variant="error">
          <AlertTitle>加载台账失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : ledger && ledger.nodes.length > 0 ? (
        <BudgetTreeTable
          nodes={ledger.nodes}
          showLevel1Total
          yearLabel={mode === 'annual' ? year : undefined}
          hideAnnualColumns={mode === 'total'}
          subjectHref={(n) =>
            // 业务记录只挂在叶科目上:仅叶科目可点。
            // 年度视图携带年份筛选;总预算视图跳该科目全部年度记录。
            n.isLeaf
              ? mode === 'annual'
                ? `/projects/${projectId}/records?subjectId=${n.subjectId}&year=${year}`
                : `/projects/${projectId}/records?subjectId=${n.subjectId}`
              : undefined
          }
        />
      ) : mode === 'annual' ? (
        <Alert variant="info">
          <AlertTitle>{year} 年度暂无预算执行数据</AlertTitle>
          <AlertDescription>
            可能是尚未编制或审批通过该年度的初始预算,或本年度还没有业务记录。
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="info">
          <AlertTitle>暂无预算执行数据</AlertTitle>
          <AlertDescription>
            按总预算口径:可能是尚未编制或审批通过初始预算,或还没有任何业务记录。
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
