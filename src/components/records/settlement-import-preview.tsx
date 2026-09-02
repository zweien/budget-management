'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import { SETTLEMENT_TEMPLATE_VERSION } from '@/lib/excel/settlement';
import { STATUS_ENUM_TO_CN } from '@/lib/excel/template';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MoneyText } from '@/components/ui/MoneyText';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** GET /imports/:batchId(个人结算单批次)的一行。 */
export interface SettlementRow {
  rowId: string;
  rowNo: number;
  parsedData: {
    kind: 'settlement';
    docNo: string | null;
    statusLabel: string;
    status: string;
    businessDate: string;
    budgetYear: number;
    summary: string;
    amount: string;
    handler: string;
    subjectId: string | null;
    subjectName: string | null;
  };
  validationStatus: 'valid' | 'error' | 'skipped';
  errors: { field: string; message: string }[];
  duplicateFlag: boolean;
  /** 重复档位(ADR 0002):hard=单据编号硬重复,禁止导入;旧数据无档位按 suspected。 */
  duplicateLevel: 'none' | 'hard' | 'suspected';
  forcedImport: boolean;
  normalizedAmount: string | null;
}

export interface SettlementBatchData {
  batchId: string;
  projectId: string;
  fileName: string;
  templateVersion: string;
  status: string;
  createdAt: string;
  confirmedAt: string | null;
  pending: SettlementRow[];
  duplicates: SettlementRow[];
  errors: SettlementRow[];
  skippedCount: number;
  skippedReasons: Record<string, number>;
  leafSubjects: Array<{ id: string; code: string; name: string }>;
}

/** 行级暂存更新(PATCH /imports/:batchId)。 */
interface RowUpdate {
  rowId: string;
  subjectId?: string | null;
  budgetYear?: number;
  forcedImport?: boolean;
}

/**
 * 个人结算单导入预览(§settlement)。
 * 上传的财务系统「个人结算单查询」xlsx 无科目列:在预览页逐条(或批量)指定叶科目,
 * 每次修改即时 PATCH 暂存(批次保持 pending,可离开后从「进行中批次」继续);
 * 点「确认导入」才写业务记录。
 */
export function SettlementImportPreview({
  projectId,
  initialData,
  canEdit,
}: {
  projectId: string;
  initialData: SettlementBatchData;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState<SettlementBatchData>(initialData);
  // 可导入行 = pending + duplicates(duplicates 默认不勾选,需手动勾选强制导入)。
  const importable = useMemo(
    () => [...data.pending, ...data.duplicates],
    [data.pending, data.duplicates],
  );
  const [selected, setSelected] = useState<Set<string>>(() => {
    const s = new Set<string>();
    initialData.pending.forEach((r) => s.add(r.rowId));
    // 恢复批次:已持久化 forcedImport 的疑似重复行视为已勾选(勾选态与强制标志始终同相);
    // 硬重复行不可导入,永不勾选。
    initialData.duplicates.forEach((r) => {
      if (r.forcedImport && r.duplicateLevel !== 'hard') s.add(r.rowId);
    });
    return s;
  });
  const [confirming, setConfirming] = useState(false);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  // 暂存失败态:任何行级 PATCH 失败都置位并禁用「确认导入」,防止带着旧数据确认。
  const [saveError, setSaveError] = useState<string | null>(null);
  const patchQueue = useRef<Promise<unknown>>(Promise.resolve());

  const confirmed = data.status === 'confirmed';
  const readOnly = confirmed || !canEdit;

  const subjectOptions = useMemo(() => {
    const nameCount = new Map<string, number>();
    data.leafSubjects.forEach((s) => nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1));
    return data.leafSubjects.map((s) => ({
      value: s.id,
      label: (nameCount.get(s.name) ?? 0) > 1 ? `${s.name}(${s.code})` : s.name,
      keywords: s.code,
    }));
  }, [data.leafSubjects]);

  const subjectName = (id: string | null) =>
    id ? (subjectOptions.find((o) => o.value === id)?.label ?? null) : null;

  /** 暂存 PATCH(串行排队,避免乱序覆盖);本地状态先行乐观更新。 */
  const patchRows = (updates: RowUpdate[]) => {
    if (updates.length === 0) return;
    patchQueue.current = patchQueue.current
      .then(() =>
        apiFetch(`/api/projects/${projectId}/imports/${data.batchId}`, {
          method: 'PATCH',
          body: JSON.stringify({ updates }),
        }),
      )
      .then(() => setSaveError(null))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : '暂存失败,请重试';
        setSaveError(msg);
        toast.error(msg);
      });
  };

  const applyLocal = (
    rowId: string,
    patch: Partial<SettlementRow['parsedData']>,
    extra?: Partial<SettlementRow>,
  ) => {
    setData((prev) => {
      const mapRow = (r: SettlementRow): SettlementRow =>
        r.rowId === rowId ? { ...r, parsedData: { ...r.parsedData, ...patch }, ...extra } : r;
      return {
        ...prev,
        pending: prev.pending.map(mapRow),
        duplicates: prev.duplicates.map(mapRow),
      };
    });
  };

  const handleSubjectChange = (rowId: string, subjectId: string) => {
    const name = subjectName(subjectId);
    applyLocal(rowId, { subjectId, subjectName: name });
    patchRows([{ rowId, subjectId }]);
  };

  const handleYearChange = (
    rowId: string,
    e: React.FocusEvent<HTMLInputElement>,
    original: number,
  ) => {
    const raw = e.target.value;
    const year = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(year) || year < 1900 || year > 9999) {
      // 非受控输入:非法输入直接回显恢复,避免界面值与服务端将导入的值不一致。
      e.target.value = String(original);
      toast.warning(`预算年度须为 1900~9999 的整数,已恢复为 ${original}`);
      return;
    }
    if (year === original) return;
    applyLocal(rowId, { budgetYear: year });
    patchRows([{ rowId, budgetYear: year }]);
  };

  const toggleRow = (r: SettlementRow) => {
    if (r.duplicateLevel === 'hard') {
      toast.error('硬重复行不可导入:单据编号与未作废记录重复,请先作废旧记录');
      return;
    }
    // 重复行:勾选状态即「强制导入」标志,两者同相切换(恢复批次时也不会错位)。
    const nowSelected = !selected.has(r.rowId);
    setSelected((prev) => {
      const next = new Set(prev);
      if (nowSelected) next.add(r.rowId);
      else next.delete(r.rowId);
      return next;
    });
    if (r.duplicateFlag) {
      applyLocal(r.rowId, {}, { forcedImport: nowSelected });
      patchRows([{ rowId: r.rowId, forcedImport: nowSelected }]);
    }
  };

  const allPendingSelected =
    data.pending.length > 0 && data.pending.every((r) => selected.has(r.rowId));
  const toggleAllPending = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPendingSelected) data.pending.forEach((r) => next.delete(r.rowId));
      else data.pending.forEach((r) => next.add(r.rowId));
      return next;
    });
  };

  const [batchSubjectId, setBatchSubjectId] = useState<string | null>(null);
  const handleBatchAssign = () => {
    if (!batchSubjectId) return;
    const targets = importable.filter((r) => selected.has(r.rowId));
    targets.forEach((r) =>
      applyLocal(r.rowId, { subjectId: batchSubjectId, subjectName: subjectName(batchSubjectId) }),
    );
    patchRows(targets.map((r) => ({ rowId: r.rowId, subjectId: batchSubjectId })));
    toast.success(`已为 ${targets.length} 行指定科目(已暂存)`);
    setBatchSubjectId(null);
    setBatchDialogOpen(false);
  };

  const selectedRows = importable.filter((r) => selected.has(r.rowId));
  const unassignedCount = selectedRows.filter((r) => !r.parsedData.subjectId).length;
  const assignedCount =
    data.pending.filter((r) => r.parsedData.subjectId).length +
    data.duplicates.filter((r) => r.parsedData.subjectId).length;

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      // 确认前等待排队中的暂存请求落库,避免服务端还是旧科目。
      await patchQueue.current;
      const res = await apiFetch<{ created: number }>(
        `/api/projects/${projectId}/imports/${data.batchId}/confirm`,
        { method: 'POST', body: JSON.stringify({ selectedRowIds: [...selected] }) },
      );
      toast.success(`已导入 ${res.created} 条业务记录`);
      router.push(`/projects/${projectId}/records`);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setConfirming(false);
    }
  };

  const skipReasonText = Object.entries(data.skippedReasons)
    .map(([reason, n]) => `${reason} ${n} 行`)
    .join('、');

  const renderRow = (r: SettlementRow) => {
    const checked = selected.has(r.rowId);
    const selectable = !readOnly;
    const hard = r.duplicateLevel === 'hard';
    return (
      <TableRow
        key={r.rowId}
        className={cn(hard && 'opacity-60', r.duplicateFlag && !hard && 'bg-warning/20')}
      >
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
                checked={checked}
                onCheckedChange={() => toggleRow(r)}
                aria-label={`选择第 ${r.rowNo} 行`}
              />
            )}
          </TableCell>
        ) : null}
        <TableCell className="tabular-nums">{r.rowNo}</TableCell>
        <TableCell className="font-mono text-xs">{r.parsedData.docNo ?? '—'}</TableCell>
        <TableCell>{STATUS_ENUM_TO_CN[r.parsedData.status] ?? r.parsedData.statusLabel}</TableCell>
        <TableCell className="tabular-nums">{r.parsedData.businessDate}</TableCell>
        <TableCell className="w-20">
          {readOnly ? (
            <span className="tabular-nums">{r.parsedData.budgetYear}</span>
          ) : (
            <input
              type="number"
              defaultValue={r.parsedData.budgetYear}
              min={1900}
              max={9999}
              className="w-16 rounded border border-hairline bg-card px-1.5 py-0.5 text-xs tabular-nums"
              aria-label={`第 ${r.rowNo} 行预算年度`}
              onBlur={(e) => handleYearChange(r.rowId, e, r.parsedData.budgetYear)}
            />
          )}
        </TableCell>
        <TableCell className="max-w-56 truncate" title={r.parsedData.summary}>
          {r.parsedData.summary}
        </TableCell>
        <TableCell>
          {r.normalizedAmount ? (
            <MoneyText value={r.normalizedAmount} riskOnNegative={false} />
          ) : (
            <span className="block text-right text-mute">—</span>
          )}
        </TableCell>
        <TableCell>{r.parsedData.handler}</TableCell>
        <TableCell className="w-44">
          {readOnly ? (
            (r.parsedData.subjectName ?? <span className="text-mute">未指定</span>)
          ) : (
            <Combobox
              options={subjectOptions}
              value={r.parsedData.subjectId ?? undefined}
              onChange={(v) => handleSubjectChange(r.rowId, v)}
              placeholder={r.parsedData.subjectId ? undefined : '选择科目…'}
              searchPlaceholder="搜索科目…"
              className="h-7 w-40 text-xs"
            />
          )}
        </TableCell>
        <TableCell>
          {hard ? (
            <Badge variant="error">硬重复</Badge>
          ) : r.duplicateFlag ? (
            r.forcedImport ? (
              <Badge variant="warning">强制导入</Badge>
            ) : (
              <Badge variant="warning">疑似重复</Badge>
            )
          ) : (
            <span className="text-mute">—</span>
          )}
        </TableCell>
      </TableRow>
    );
  };

  const tableHead = (selectable: boolean, selectAll?: React.ReactNode) => (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        {selectable ? <TableHead className="w-10">{selectAll}</TableHead> : null}
        <TableHead className="w-14">行号</TableHead>
        <TableHead>单据编号</TableHead>
        <TableHead className="w-24">状态</TableHead>
        <TableHead className="w-24">填制日期</TableHead>
        <TableHead className="w-20">年度</TableHead>
        <TableHead>事项(摘要)</TableHead>
        <TableHead className="w-24 text-right">金额</TableHead>
        <TableHead className="w-20">经办人</TableHead>
        <TableHead className="w-44">科目</TableHead>
        <TableHead className="w-24">标记</TableHead>
      </TableRow>
    </TableHeader>
  );

  if (confirmed) {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold tracking-[-0.3px]">导入预览(个人结算单)</h2>
        <Alert variant="success">
          <AlertTitle>
            该批次已于 {data.confirmedAt?.slice(0, 19).replace('T', ' ')} 确认入库。
          </AlertTitle>
          <AlertDescription>
            文件:{data.fileName};可在「业务记录」页查看导入的记录(含单据编号)。
          </AlertDescription>
        </Alert>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">导入明细({importable.length} 行)</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              {tableHead(false)}
              <TableBody>{importable.map(renderRow)}</TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-[-0.3px]">导入预览(个人结算单)</h2>
        <Button variant="outline" onClick={() => router.push(`/projects/${projectId}/records`)}>
          暂存退出
        </Button>
      </div>

      <Alert variant="info">
        <AlertTitle>
          文件:{data.fileName}
          {data.skippedCount > 0 ? `;已忽略 ${skipReasonText}(不导入)` : ''}
        </AlertTitle>
        <AlertDescription>
          财务系统导出的结算单没有科目信息:请为每行指定叶科目(支持勾选多行后批量设置)。
          所有修改即时暂存,可稍后回来继续;点「确认导入」才写入业务记录。
          预算年度默认取填制日期年份,可按行修改。
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-3">
          <p className="caption-mono">待导入行</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{importable.length}</p>
        </Card>
        <Card className="p-3">
          <p className="caption-mono">已指定科目</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{assignedCount}</p>
        </Card>
        <Card className="p-3">
          <p className="caption-mono">重复行</p>
          <p className="mt-1 text-xl font-semibold text-warning-deep tabular-nums">
            {data.duplicates.length}
          </p>
          {data.duplicates.some((r) => r.duplicateLevel === 'hard') && (
            <p className="text-xs text-error-deep">含硬重复行,禁止导入</p>
          )}
        </Card>
        <Card className="p-3">
          <p className="caption-mono">错误行</p>
          <p className="mt-1 text-xl font-semibold text-error-deep tabular-nums">
            {data.errors.length}
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">
            待导入行({importable.length})
            {unassignedCount > 0 ? (
              <span className="ml-2 text-xs font-normal text-warning-deep">
                勾选中 {unassignedCount} 行未指定科目
              </span>
            ) : null}
          </CardTitle>
          {!readOnly ? (
            <Button
              variant="outline"
              size="sm"
              disabled={selected.size === 0}
              onClick={() => setBatchDialogOpen(true)}
            >
              批量设置科目({selected.size} 行)
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {importable.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">无可导入行</p>
          ) : (
            <Table>
              {tableHead(
                !readOnly,
                !readOnly ? (
                  <Checkbox
                    checked={allPendingSelected}
                    onCheckedChange={toggleAllPending}
                    aria-label="全选待导入行"
                  />
                ) : null,
              )}
              <TableBody>{importable.map(renderRow)}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {data.errors.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              错误行({data.errors.length})<Badge variant="error">不可导入</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-14">行号</TableHead>
                  <TableHead>单据编号</TableHead>
                  <TableHead>事项</TableHead>
                  <TableHead className="w-24 text-right">金额</TableHead>
                  <TableHead>错误</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.errors.map((r) => (
                  <TableRow key={r.rowId}>
                    <TableCell className="tabular-nums">{r.rowNo}</TableCell>
                    <TableCell className="font-mono text-xs">{r.parsedData.docNo ?? '—'}</TableCell>
                    <TableCell className="max-w-56 truncate">
                      {r.parsedData.summary || '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.parsedData.amount || '—'}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-0.5">
                        {r.errors.map((e, i) => (
                          <p key={i} className="text-xs text-error-deep">
                            {e.message}
                          </p>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {canEdit ? (
        <div className="flex items-center justify-end gap-3">
          {saveError ? (
            <p className="text-xs text-error-deep">暂存失败:{saveError},修改未落库前无法确认导入</p>
          ) : unassignedCount > 0 ? (
            <p className="text-xs text-mute">
              勾选行中还有 {unassignedCount} 行未指定科目,指定后才能确认导入
            </p>
          ) : null}
          <Button
            disabled={
              selected.size === 0 || unassignedCount > 0 || confirming || saveError !== null
            }
            onClick={handleConfirm}
          >
            {confirming ? '导入中…' : `确认导入(${selected.size} 行)`}
          </Button>
        </div>
      ) : (
        <Alert variant="info">
          <AlertTitle>你只有查看权限,无法确认导入。</AlertTitle>
        </Alert>
      )}

      <Dialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>批量设置科目({selected.size} 行)</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-mute">
            将为勾选的行统一指定叶科目,并即时暂存。疑似重复行若被勾选,需在表格中单独勾选「强制导入」才会真正导入。
          </p>
          <Combobox
            options={subjectOptions}
            value={batchSubjectId ?? undefined}
            onChange={setBatchSubjectId}
            placeholder="选择科目…"
            searchPlaceholder="搜索科目…"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchDialogOpen(false)}>
              取消
            </Button>
            <Button disabled={!batchSubjectId} onClick={handleBatchAssign}>
              应用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const isSettlementTemplate = (v: string) => v === SETTLEMENT_TEMPLATE_VERSION;
