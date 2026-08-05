'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { FileSpreadsheet, Inbox } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch, bootstrapMockUser } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/layout/empty-state';
import { MoneyText } from '@/components/ui/MoneyText';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** §10 预览页一行(对应 GET /imports/:batchId 返回的三分组项)。 */
interface PreviewRow {
  rowId: string;
  rowNo: number;
  parsedData: {
    projectCode: string | null;
    budgetYear: string | null;
    subjectCode: string | null;
    subjectName: string | null;
    amount: string | null;
    businessDate: string | null;
    handler: string | null;
    summary: string | null;
    businessStatus: string | null;
    remark: string | null;
  };
  validationStatus: 'valid' | 'error';
  errors: { field: string; message: string }[];
  duplicateFlag: boolean;
  forcedImport: boolean;
  normalizedAmount: string | null;
  normalizedStatus: string | null;
}

interface BatchPreview {
  batchId: string;
  projectId: string;
  fileName: string;
  templateVersion: string;
  status: string;
  createdAt: string;
  confirmedAt: string | null;
  valid: PreviewRow[];
  errors: PreviewRow[];
  duplicates: PreviewRow[];
}

/** 上传文件(走原生 fetch + mock header,不用 apiFetch 的 JSON Content-Type)。 */
async function uploadExcel(projectId: string, file: File): Promise<string> {
  const mockUserId = await bootstrapMockUser();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/projects/${projectId}/imports`, {
    method: 'POST',
    headers: mockUserId ? { 'x-mock-user-id': mockUserId } : {},
    body: form,
  });
  const isJson = (res.headers.get('Content-Type') ?? '').includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `上传失败 (${res.status})`;
    throw new Error(msg);
  }
  return (body as { batchId: string }).batchId;
}

/** 下载模板(走原生 fetch + mock header,以触发文件下载)。 */
async function downloadTemplate(): Promise<void> {
  const mockUserId = await bootstrapMockUser();
  const res = await fetch('/api/excel-template', {
    headers: mockUserId ? { 'x-mock-user-id': mockUserId } : {},
  });
  if (!res.ok) {
    throw new Error(`下载模板失败 (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'business-records-template.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function PreviewTable({
  rows,
  selectable,
  selected,
  onToggle,
  emptyText,
}: {
  rows: PreviewRow[];
  selectable: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {selectable ? <TableHead className="w-10" /> : null}
          <TableHead className="w-14">行号</TableHead>
          <TableHead>项目编号</TableHead>
          <TableHead className="w-16">年度</TableHead>
          <TableHead>科目</TableHead>
          <TableHead className="w-28 text-right">金额</TableHead>
          <TableHead className="w-28">业务日期</TableHead>
          <TableHead className="w-20">经办人</TableHead>
          <TableHead>摘要</TableHead>
          <TableHead className="w-24">业务状态</TableHead>
          <TableHead>备注</TableHead>
          <TableHead className="w-56">错误</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.rowId}>
            {selectable ? (
              <TableCell className="pr-0">
                <Checkbox
                  checked={selected.has(r.rowId)}
                  onCheckedChange={() => onToggle(r.rowId)}
                  aria-label={`选择第 ${r.rowNo} 行`}
                />
              </TableCell>
            ) : null}
            <TableCell className="tabular-nums">{r.rowNo}</TableCell>
            <TableCell className="font-mono text-xs">{r.parsedData.projectCode ?? '—'}</TableCell>
            <TableCell className="tabular-nums">{r.parsedData.budgetYear ?? '—'}</TableCell>
            <TableCell>
              {r.parsedData.subjectName ?? r.parsedData.subjectCode ?? (
                <span className="text-mute">—</span>
              )}
            </TableCell>
            <TableCell>
              {r.normalizedAmount ? (
                <MoneyText value={r.normalizedAmount} riskOnNegative={false} />
              ) : (
                <span className="block text-right text-mute">—</span>
              )}
            </TableCell>
            <TableCell className="tabular-nums">{r.parsedData.businessDate ?? '—'}</TableCell>
            <TableCell>{r.parsedData.handler ?? '—'}</TableCell>
            <TableCell className="max-w-36 truncate" title={r.parsedData.summary ?? undefined}>
              {r.parsedData.summary ?? '—'}
            </TableCell>
            <TableCell>{r.parsedData.businessStatus ?? '—'}</TableCell>
            <TableCell className="max-w-36 truncate" title={r.parsedData.remark ?? undefined}>
              {r.parsedData.remark ?? <span className="text-mute">—</span>}
            </TableCell>
            <TableCell>
              {r.errors.length > 0 ? (
                <div className="space-y-0.5">
                  {r.errors.map((e, i) => (
                    <p key={i} className="text-xs text-error-deep">
                      {e.field}:{e.message}
                    </p>
                  ))}
                </div>
              ) : (
                <span className="text-mute">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ImportPageInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const projectId = params.id;
  const batchId = search.get('batch') ?? null;

  const [preview, setPreview] = useState<BatchPreview | null>(null);
  // 进入预览模式(batchId 非空)时初始即为 loading;所有 setState 仅在 await 之后。
  const [loading, setLoading] = useState<boolean>(!!batchId);
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // 首次/批次切换时拉取预览;effect 体内不调用 setState(全部在 Promise 回调中)。
  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    apiFetch<BatchPreview>(`/api/projects/${projectId}/imports/${batchId}`)
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        // §10.3 疑似重复默认不勾选;有效行默认全选。
        const sel = new Set<string>();
        data.valid.forEach((r) => sel.add(r.rowId));
        setSelected(sel);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof Error) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, projectId]);

  /** 校验并上传单个 .xlsx 文件。 */
  const handleFile = async (f: File) => {
    if (!/\.xlsx$/i.test(f.name)) {
      toast.error('仅支持 .xlsx 文件');
      return;
    }
    setUploading(true);
    try {
      const newBatchId = await uploadExcel(projectId, f);
      toast.success('解析完成,跳转预览');
      router.push(`/projects/${projectId}/imports?batch=${newBatchId}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (!preview) return;
    setConfirming(true);
    try {
      const res = await apiFetch<{ created: number }>(
        `/api/projects/${projectId}/imports/${preview.batchId}/confirm`,
        {
          method: 'POST',
          body: JSON.stringify({ selectedRowIds: [...selected] }),
        },
      );
      toast.success(`已导入 ${res.created} 条业务记录`);
      router.push(`/projects/${projectId}/ledger`);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setConfirming(false);
    }
  };

  const stats = useMemo(() => {
    if (!preview) return null;
    return {
      valid: preview.valid.length,
      errors: preview.errors.length,
      duplicates: preview.duplicates.length,
      selected: selected.size,
    };
  }, [preview, selected]);

  if (uploading || (loading && !preview)) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  // ---- 预览模式 ----
  if (batchId) {
    if (error || !preview) {
      return (
        <EmptyState
          icon={<FileSpreadsheet />}
          title="无法加载导入预览"
          description={error ?? '批次可能不存在或已被清理。'}
          action={
            <Button onClick={() => router.push(`/projects/${projectId}/imports`)}>重新上传</Button>
          }
        />
      );
    }

    const confirmed = preview.status === 'confirmed';

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-[-0.3px]">导入预览</h2>
          <Button variant="outline" onClick={() => router.push(`/projects/${projectId}/imports`)}>
            重新上传
          </Button>
        </div>

        {/* 统计行 */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="p-3">
            <p className="caption-mono">有效行</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{stats?.valid ?? 0}</p>
          </Card>
          <Card className="p-3">
            <p className="caption-mono">错误行</p>
            <p className="mt-1 text-xl font-semibold text-error-deep tabular-nums">
              {stats?.errors ?? 0}
            </p>
          </Card>
          <Card className="p-3">
            <p className="caption-mono">疑似重复</p>
            <p className="mt-1 text-xl font-semibold text-warning-deep tabular-nums">
              {stats?.duplicates ?? 0}
            </p>
          </Card>
          <Card className="p-3">
            <p className="caption-mono">已勾选</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{stats?.selected ?? 0}</p>
          </Card>
        </div>

        <Alert variant="info">
          <AlertTitle>
            文件:{preview.fileName}(模板 v{preview.templateVersion})
          </AlertTitle>
          <AlertDescription>
            {confirmed
              ? '该批次已确认入库。'
              : '勾选要导入的行(疑似重复行默认不勾选,可手动勾选强制导入,§10.3)。错误行不可导入,请修正后重新上传。'}
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">有效行({preview.valid.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <PreviewTable
              rows={preview.valid}
              selectable={!confirmed}
              selected={selected}
              onToggle={toggleRow}
              emptyText="无有效行"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              疑似重复行({preview.duplicates.length})<Badge variant="warning">默认不导入</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PreviewTable
              rows={preview.duplicates}
              selectable={!confirmed}
              selected={selected}
              onToggle={toggleRow}
              emptyText="无疑似重复行"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">错误行({preview.errors.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <PreviewTable
              rows={preview.errors}
              selectable={false}
              selected={selected}
              onToggle={toggleRow}
              emptyText="无错误行"
            />
          </CardContent>
        </Card>

        {!confirmed ? (
          <div className="flex justify-end">
            <Button disabled={selected.size === 0 || confirming} onClick={handleConfirm}>
              {confirming ? '导入中…' : `确认导入(${selected.size} 行)`}
            </Button>
          </div>
        ) : (
          <Alert variant="success">
            <AlertTitle>该批次已确认入库。</AlertTitle>
          </Alert>
        )}
      </div>
    );
  }

  // ---- 上传模式 ----
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-[-0.3px]">Excel 批量导入</h2>
        <Button
          variant="outline"
          onClick={() => downloadTemplate().catch((e) => toast.error(e.message))}
        >
          下载模板
        </Button>
      </div>

      <Alert variant="info">
        <AlertTitle>两阶段导入:上传校验 → 预览确认</AlertTitle>
        <AlertDescription>
          上传后将逐行校验(项目编号/年度/叶科目/金额/状态/日期),识别疑似重复行,生成预览。
          在预览页勾选有效行后点击「确认导入」才会写入业务记录。超预算行允许导入(§10.2)。
          请先下载模板按格式填写。
        </AlertDescription>
      </Alert>

      {/* 拖放上传区(原生 file input + drag events,替代 antd Dragger) */}
      <label
        className={cn(
          'flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed bg-card px-6 py-14 text-center transition-colors',
          dragOver
            ? 'border-ring bg-accent/60'
            : 'border-hairline-strong hover:border-ring hover:bg-accent/40',
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handleFile(f);
        }}
      >
        <Inbox className="size-8 text-mute" />
        <p className="text-sm">点击或拖拽 .xlsx 文件到此处上传</p>
        <p className="text-xs text-mute">仅支持单个 .xlsx 文件,需符合模板列顺序</p>
        <input
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = '';
          }}
        />
      </label>
    </div>
  );
}

export default function ImportPage() {
  // useSearchParams 需在 Suspense 边界内。
  return (
    <Suspense
      fallback={
        <div className="space-y-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-48 w-full" />
        </div>
      }
    >
      <ImportPageInner />
    </Suspense>
  );
}
