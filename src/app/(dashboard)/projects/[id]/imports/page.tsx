'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { FileSpreadsheet, Inbox } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch, bootstrapMockUser } from '@/lib/api/client';
import { SETTLEMENT_TEMPLATE_VERSION } from '@/lib/excel/settlement';
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
import {
  SettlementImportPreview,
  type SettlementBatchData,
} from '@/components/records/settlement-import-preview';

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
    docNo: string | null;
  };
  validationStatus: 'valid' | 'error';
  errors: { field: string; message: string }[];
  duplicateFlag: boolean;
  /** 重复档位(ADR 0002):hard=单据编号硬重复,禁止导入;旧数据无档位按 suspected。 */
  duplicateLevel: 'none' | 'hard' | 'suspected';
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

/** 批次列表项(GET /imports)。 */
interface BatchListItem {
  batchId: string;
  fileName: string;
  templateVersion: string;
  status: string;
  createdAt: string;
  confirmedAt: string | null;
  rowCount: number;
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
  isHardRow,
  emptyText,
}: {
  rows: PreviewRow[];
  selectable: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** 硬重复行(仅重复分组传入):勾选框禁用,行内展示「硬重复」徽标。 */
  isHardRow?: (r: PreviewRow) => boolean;
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
          <TableHead className="w-28">单据编号</TableHead>
          <TableHead className="w-24">业务状态</TableHead>
          <TableHead>备注</TableHead>
          <TableHead className="w-56">错误</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const hard = isHardRow?.(r) ?? false;
          return (
            <TableRow key={r.rowId} className={hard ? 'opacity-60' : undefined}>
              {selectable ? (
                <TableCell className="pr-0">
                  {hard ? (
                    <span
                      className="inline-block size-4 rounded border border-input bg-muted"
                      title="硬重复:单据编号与未作废记录重复,禁止导入"
                      aria-label={`第 ${r.rowNo} 行硬重复,不可导入`}
                    />
                  ) : (
                    <Checkbox
                      checked={selected.has(r.rowId)}
                      onCheckedChange={() => onToggle(r.rowId)}
                      aria-label={`选择第 ${r.rowNo} 行`}
                    />
                  )}
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
              <TableCell className="font-mono text-xs">
                {hard ? (
                  <Badge variant="error">硬重复</Badge>
                ) : (
                  (r.parsedData.docNo ?? <span className="text-mute">—</span>)
                )}
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
          );
        })}
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

  // 预览载荷:标准模板(BatchPreview)或个人结算单(SettlementBatchData),按 templateVersion 分流。
  const [preview, setPreview] = useState<BatchPreview | SettlementBatchData | null>(null);
  // 进入预览模式(batchId 非空)时初始即为 loading;所有 setState 仅在 await 之后。
  const [loading, setLoading] = useState<boolean>(!!batchId);
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // 进行中/历史批次(暂存再入口)。
  const [batches, setBatches] = useState<BatchListItem[] | null>(null);
  // 编辑权门控:undefined=未加载;false=只读(隐藏上传/确认入口)。
  const [canEdit, setCanEdit] = useState<boolean | undefined>(undefined);

  // 拉取项目详情拿 canEdit(只读用户隐藏导入入口;服务端 record:import 二次拦截)。
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ canEdit?: boolean }>(`/api/projects/${projectId}`)
      .then((p) => {
        if (!cancelled) setCanEdit(p.canEdit ?? false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 上传模式:拉取批次列表(进行中批次可继续)。
  useEffect(() => {
    if (batchId || canEdit === false) return;
    let cancelled = false;
    apiFetch<{ batches: BatchListItem[] }>(`/api/projects/${projectId}/imports`)
      .then((d) => {
        if (!cancelled) setBatches(d.batches);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [batchId, projectId, canEdit]);

  // 首次/批次切换时拉取预览;effect 体内不调用 setState(全部在 Promise 回调中)。
  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    apiFetch<BatchPreview | SettlementBatchData>(`/api/projects/${projectId}/imports/${batchId}`)
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        // §10.3 疑似重复默认不勾选;有效行默认全选(仅标准模板;结算单由其组件自管)。
        if (data.templateVersion !== SETTLEMENT_TEMPLATE_VERSION) {
          const sel = new Set<string>();
          (data as BatchPreview).valid.forEach((r) => sel.add(r.rowId));
          setSelected(sel);
        }
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

  /** 硬重复行(单据编号同号)不可勾选——服务端 confirm 亦会拒绝。 */
  const isHard = (r: PreviewRow) => r.duplicateLevel === 'hard';
  const hardCount = preview
    ? ((preview as BatchPreview).duplicates?.filter(isHard).length ?? 0)
    : 0;

  const handleConfirm = async () => {
    if (!preview) return;
    setConfirming(true);
    try {
      const res = await apiFetch<{ created: number }>(
        // 结算单批次由 SettlementImportPreview 自行确认,此处必为标准模板载荷。
        `/api/projects/${projectId}/imports/${(preview as BatchPreview).batchId}/confirm`,
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
    if (!preview || preview.templateVersion === SETTLEMENT_TEMPLATE_VERSION) return null;
    const std = preview as BatchPreview;
    return {
      valid: std.valid.length,
      errors: std.errors.length,
      duplicates: std.duplicates.length,
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

    // 个人结算单批次:整页交给结算单预览组件(逐条科目指定 + 暂存)。
    if (preview.templateVersion === SETTLEMENT_TEMPLATE_VERSION) {
      return (
        <SettlementImportPreview
          projectId={projectId}
          initialData={preview as SettlementBatchData}
          canEdit={canEdit === true}
        />
      );
    }

    const standard = preview as BatchPreview;
    const confirmed = standard.status === 'confirmed';

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
            <p className="caption-mono">重复行</p>
            <p className="mt-1 text-xl font-semibold text-warning-deep tabular-nums">
              {stats?.duplicates ?? 0}
            </p>
            {hardCount > 0 && (
              <p className="text-xs text-error-deep">其中硬重复 {hardCount} 行不可导入</p>
            )}
          </Card>
          <Card className="p-3">
            <p className="caption-mono">已勾选</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{stats?.selected ?? 0}</p>
          </Card>
        </div>

        <Alert variant="info">
          <AlertTitle>
            文件:{standard.fileName}(模板 v{standard.templateVersion})
          </AlertTitle>
          <AlertDescription>
            {confirmed
              ? '该批次已确认入库。'
              : '勾选要导入的行。未填单据编号的行按(年度+金额+日期+摘要)识别疑似重复,默认不勾选、可强制导入;单据编号与未作废记录同号为硬重复,禁止导入(先作废旧记录方可重导)。错误行不可导入,请修正后重新上传。'}
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">有效行({standard.valid.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <PreviewTable
              rows={standard.valid}
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
              重复行({standard.duplicates.length})
              {hardCount > 0 && <Badge variant="error">硬重复 {hardCount} 行禁止导入</Badge>}
              <Badge variant="warning">疑似默认不导入</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <PreviewTable
              rows={standard.duplicates}
              selectable={!confirmed}
              selected={selected}
              onToggle={toggleRow}
              isHardRow={isHard}
              emptyText="无重复行"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">错误行({standard.errors.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <PreviewTable
              rows={standard.errors}
              selectable={false}
              selected={selected}
              onToggle={toggleRow}
              emptyText="无错误行"
            />
          </CardContent>
        </Card>

        {!confirmed ? (
          canEdit ? (
            <div className="flex justify-end">
              <Button disabled={selected.size === 0 || confirming} onClick={handleConfirm}>
                {confirming ? '导入中…' : `确认导入(${selected.size} 行)`}
              </Button>
            </div>
          ) : (
            <Alert variant="info">
              <AlertTitle>你只有查看权限,无法确认导入。</AlertTitle>
            </Alert>
          )
        ) : (
          <Alert variant="success">
            <AlertTitle>该批次已确认入库。</AlertTitle>
          </Alert>
        )}
      </div>
    );
  }

  // ---- 上传模式 ----
  if (canEdit === false) {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold tracking-[-0.3px]">Excel 批量导入</h2>
        <Alert variant="info">
          <AlertTitle>你只有查看权限</AlertTitle>
          <AlertDescription>
            导入业务记录需要该项目的编辑权限(项目负责人在项目详情页设定,或联系管理员)。
          </AlertDescription>
        </Alert>
      </div>
    );
  }

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
          支持两种文件,上传时自动识别:① 系统模板(下载模板后按列填写,文件内含科目编码); ②
          财务系统导出的「个人结算单查询」(表头在第 4 行,无科目列,预览页逐条指定科目)。
          上传后逐行校验并识别疑似重复;确认导入才写入业务记录,期间可暂存退出。
        </AlertDescription>
      </Alert>

      {/* 进行中 / 历史批次(结算单导入的暂存再入口)。 */}
      {batches && batches.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">导入批次</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>文件</TableHead>
                  <TableHead className="w-32">类型</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-20 tabular-nums">行数</TableHead>
                  <TableHead className="w-40">上传时间</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((b) => (
                  <TableRow key={b.batchId}>
                    <TableCell className="max-w-64 truncate" title={b.fileName}>
                      {b.fileName}
                    </TableCell>
                    <TableCell>
                      {b.templateVersion === SETTLEMENT_TEMPLATE_VERSION ? (
                        <Badge>个人结算单</Badge>
                      ) : (
                        <Badge variant="secondary">标准模板</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {b.status === 'confirmed' ? (
                        <Badge variant="secondary">已导入</Badge>
                      ) : (
                        <Badge variant="warning">进行中</Badge>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">{b.rowCount}</TableCell>
                    <TableCell className="tabular-nums text-xs">
                      {b.createdAt.slice(0, 16).replace('T', ' ')}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          router.push(`/projects/${projectId}/imports?batch=${b.batchId}`)
                        }
                      >
                        {b.status === 'confirmed' ? '查看' : '继续'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

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
