'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import { isSettlementTemplateVersion } from '@/lib/excel/settlement';
import { STATUS_ENUM_TO_CN } from '@/lib/excel/template';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
    /** 完成日期(仅 v2 申请日期版;可空)。 */
    completedDate?: string | null;
    /** 硬重复理由(悬浮展示;非硬重复行为空)。 */
    dupReason?: string | null;
    budgetYear: number;
    summary: string;
    amount: string;
    handler: string;
    subjectId: string | null;
    subjectName: string | null;
    /** ---- v3(财务结算单 2025 导出)专属 ---- */
    detailPath?: string | null;
    finCode?: string | null;
    fileProjectName?: string | null;
    targetProjectId?: string | null;
    sourceRows?: number[];
  };
  validationStatus: 'valid' | 'error' | 'skipped';
  errors: { field: string; message: string }[];
  duplicateFlag: boolean;
  /** 重复档位(ADR 0002):hard=单据编号硬重复禁止导入;refresh=补全更新(确认后更新既有记录);
   *  旧数据无档位按 suspected。 */
  duplicateLevel: 'none' | 'hard' | 'suspected' | 'refresh';
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
  projectName?: string | null;
  projectMappings?: Array<{ fileProjectName: string; targetProjectId: string | null }>;
  mappableProjects?: Array<{ id: string; name: string }>;
  leafSubjectsByProject?: Record<string, Array<{ id: string; code: string; name: string }>>;
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
  /** 暂存退出/完成后的返回路径(缺省回承载项目记录页;统一导入入口传业务录入页)。 */
  exitTo,
  onExit,
}: {
  projectId: string;
  initialData: SettlementBatchData;
  canEdit: boolean;
  exitTo?: string;
  /** 退出前的额外清理(统一导入入口用它切回上传模式)。 */
  onExit?: () => void;
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
      if (r.duplicateLevel === 'refresh')
        s.add(r.rowId); // 补全更新行默认勾选。
      else if (r.forcedImport && r.duplicateLevel !== 'hard') s.add(r.rowId);
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
  // v3(财务结算单 2025 导出):行上展示 开支细项/科目代码,顶部做项目名核对警告。
  // v3(财务结算单 2025 导出):行上展示 开支细项/科目代码,顶部做项目映射。
  const isV3 = data.templateVersion === 'settlement-2.0';
  const projectMappings = data.projectMappings ?? [];
  const mappableProjects = data.mappableProjects ?? [];
  const [remapping, setRemapping] = useState(false);
  // v3 勾选行跨多个目标项目时,批量设置科目不可用(科目须属于各自目标项目)。
  const multiTargetV3 =
    isV3 &&
    new Set([...data.pending, ...data.duplicates].map((r) => r.parsedData.targetProjectId ?? ''))
      .size > 1;

  const subjectOptions = useMemo(() => {
    const nameCount = new Map<string, number>();
    data.leafSubjects.forEach((s) => nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1));
    return data.leafSubjects.map((s) => ({
      value: s.id,
      label: (nameCount.get(s.name) ?? 0) > 1 ? `${s.name}(${s.code})` : s.name,
      keywords: s.code,
    }));
  }, [data.leafSubjects]);

  /** 行级科目选项:v3 按行目标项目的叶科目;其余回退上传项目清单。 */
  const subjectOptionsFor = (r: SettlementRow) => {
    const t = r.parsedData.targetProjectId;
    const list =
      (t && data.leafSubjectsByProject?.[t]?.length
        ? data.leafSubjectsByProject[t]
        : data.leafSubjects) ?? [];
    const nameCount = new Map<string, number>();
    list.forEach((s) => nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1));
    return list.map((s) => ({
      value: s.id,
      label: (nameCount.get(s.name) ?? 0) > 1 ? `${s.name}(${s.code})` : s.name,
      keywords: s.code,
    }));
  };

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

  const handleSubjectChange = (row: SettlementRow, subjectId: string) => {
    const name = subjectOptionsFor(row).find((o) => o.value === subjectId)?.label ?? null;
    applyLocal(row.rowId, { subjectId, subjectName: name });
    patchRows([{ rowId: row.rowId, subjectId }]);
  };

  /** 项目映射(v3):对同名科研项目名称的全部行设置目标项目,服务端重算后重拉预览。 */
  const applyProjectMapping = async (fileProjectName: string, targetProjectId: string) => {
    setRemapping(true);
    try {
      const rows = [...data.pending, ...data.duplicates, ...data.errors].filter(
        (r) => r.parsedData.fileProjectName === fileProjectName,
      );
      await apiFetch(`/api/projects/${projectId}/imports/${data.batchId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          updates: rows.map((r) => ({ rowId: r.rowId, targetProjectId })),
        }),
      });
      const fresh = await apiFetch<SettlementBatchData>(
        `/api/projects/${projectId}/imports/${data.batchId}`,
      );
      setData(fresh);
      setSelected(() => {
        const sel = new Set<string>();
        fresh.pending.forEach((r) => sel.add(r.rowId));
        fresh.duplicates.forEach((r) => {
          if (r.duplicateLevel === 'refresh') sel.add(r.rowId);
          else if (r.forcedImport && r.duplicateLevel !== 'hard') sel.add(r.rowId);
        });
        return sel;
      });
      toast.success('已映射目标项目');
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setRemapping(false);
    }
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
    if (r.duplicateLevel === 'refresh') {
      // 补全更新行:勾选只影响是否执行更新,无强制导入标志。
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(r.rowId)) next.delete(r.rowId);
        else next.add(r.rowId);
        return next;
      });
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
    // 科目名按行目标解析(v3 不同行可能属于不同目标项目)。
    targets.forEach((r) => {
      const name = subjectOptionsFor(r).find((o) => o.value === batchSubjectId)?.label ?? null;
      applyLocal(r.rowId, { subjectId: batchSubjectId, subjectName: name });
    });
    patchRows(targets.map((r) => ({ rowId: r.rowId, subjectId: batchSubjectId })));
    toast.success(`已为 ${targets.length} 行指定科目(已暂存)`);
    setBatchSubjectId(null);
    setBatchDialogOpen(false);
  };

  const selectedRows = importable.filter((r) => selected.has(r.rowId));
  // refresh(补全更新)行不新增记录,不需要科目,不计入未指定数。
  const unassignedCount = selectedRows.filter(
    (r) => r.duplicateLevel !== 'refresh' && !r.parsedData.subjectId,
  ).length;
  const assignedCount =
    data.pending.filter((r) => r.parsedData.subjectId).length +
    data.duplicates.filter((r) => r.parsedData.subjectId).length;

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      // 确认前等待排队中的暂存请求落库,避免服务端还是旧科目。
      await patchQueue.current;
      const res = await apiFetch<{ created: number; updated: number }>(
        `/api/projects/${projectId}/imports/${data.batchId}/confirm`,
        { method: 'POST', body: JSON.stringify({ selectedRowIds: [...selected] }) },
      );
      toast.success(
        res.updated > 0
          ? `已导入 ${res.created} 条,补全更新 ${res.updated} 条`
          : `已导入 ${res.created} 条业务记录`,
      );
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
                title={`硬重复,禁止导入:${r.parsedData.dupReason ?? '单据编号与未作废记录重复'}`}
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
        <TableCell className="tabular-nums">
          {r.parsedData.completedDate || <span className="text-mute">—</span>}
        </TableCell>
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
        {isV3 ? (
          <TableCell
            className="max-w-48 truncate"
            title={[
              r.parsedData.detailPath,
              r.parsedData.finCode ? `科目代码:${r.parsedData.finCode}` : null,
            ]
              .filter(Boolean)
              .join('\n')}
          >
            <span className="block truncate">
              {r.parsedData.detailPath ? (r.parsedData.detailPath.split('/').pop() ?? '') : '—'}
              {r.parsedData.finCode ? (
                <span className="ml-1 text-xs text-mute">{r.parsedData.finCode}</span>
              ) : null}
              {r.parsedData.sourceRows && r.parsedData.sourceRows.length > 1 ? (
                <span className="ml-1 text-xs text-mute">
                  (合并 {r.parsedData.sourceRows.length} 行)
                </span>
              ) : null}
            </span>
          </TableCell>
        ) : null}
        <TableCell>
          {r.normalizedAmount ? (
            <MoneyText value={r.normalizedAmount} riskOnNegative={false} />
          ) : (
            <span className="block text-right text-mute">—</span>
          )}
        </TableCell>
        <TableCell>{r.parsedData.handler}</TableCell>
        <TableCell className="w-44">
          {r.duplicateLevel === 'refresh' ? (
            <span className="text-mute">无需科目</span>
          ) : readOnly ? (
            (r.parsedData.subjectName ?? <span className="text-mute">未指定</span>)
          ) : (
            <Combobox
              options={subjectOptionsFor(r)}
              value={r.parsedData.subjectId ?? undefined}
              onChange={(v) => handleSubjectChange(r, v)}
              placeholder={r.parsedData.subjectId ? undefined : '选择科目…'}
              searchPlaceholder="搜索科目…"
              className="h-7 w-40 text-xs"
            />
          )}
        </TableCell>
        <TableCell>
          {hard ? (
            <Badge
              variant="error"
              title={`硬重复,禁止导入:${r.parsedData.dupReason ?? '单据编号与未作废记录重复'}`}
            >
              硬重复
            </Badge>
          ) : r.duplicateLevel === 'refresh' ? (
            <Badge
              variant="default"
              title="同单据编号已有记录且带来新信息(补完成日期缺口/状态推进到已支出),确认后更新既有记录而非新增"
            >
              补全更新
            </Badge>
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
        <TableHead className="w-28">申请/填制日期</TableHead>
        <TableHead className="w-24">完成日期</TableHead>
        <TableHead className="w-20">年度</TableHead>
        <TableHead>事项(摘要)</TableHead>
        {isV3 ? <TableHead className="w-56">开支细项 / 科目代码</TableHead> : null}
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
        <h2 className="text-base font-semibold tracking-[-0.3px]">
          导入预览({isV3 ? '财务结算单' : '个人结算单'})
        </h2>
        <Button
          variant="outline"
          onClick={() => {
            onExit?.();
            router.push(exitTo ?? `/projects/${projectId}/records`);
          }}
        >
          暂存退出
        </Button>
      </div>

      {isV3 && projectMappings.length > 0 ? (
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="caption-mono">项目映射</p>
            {remapping ? <span className="text-xs text-mute">映射保存中…</span> : null}
          </div>
          <div className="space-y-2">
            {projectMappings.map((m) => {
              const mapped = m.targetProjectId
                ? mappableProjects.find((p) => p.id === m.targetProjectId)
                : null;
              const rowCount = [...data.pending, ...data.duplicates, ...data.errors].filter(
                (r) => r.parsedData.fileProjectName === m.fileProjectName,
              ).length;
              return (
                <div key={m.fileProjectName} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="max-w-[22rem] truncate font-medium" title={m.fileProjectName}>
                    {m.fileProjectName}
                  </span>
                  <span className="text-mute">({rowCount} 行)→</span>
                  {readOnly ? (
                    <span>{mapped?.name ?? '未映射'}</span>
                  ) : (
                    <Select
                      value={m.targetProjectId ?? undefined}
                      disabled={remapping}
                      onValueChange={(v) => void applyProjectMapping(m.fileProjectName, v)}
                    >
                      <SelectTrigger className="w-72">
                        <SelectValue placeholder="选择目标项目…" />
                      </SelectTrigger>
                      <SelectContent>
                        {mappableProjects.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {!mapped ? <Badge variant="error">未映射</Badge> : null}
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      <Alert variant="info">
        <AlertTitle>
          文件:{data.fileName}
          {data.skippedCount > 0 ? `;已忽略 ${skipReasonText}(不导入)` : ''}
        </AlertTitle>
        <AlertDescription>
          财务系统导出的结算单没有科目信息:请为每行指定叶科目(支持勾选多行后批量设置)。
          所有修改即时暂存,可稍后回来继续;点「确认导入」才写入业务记录。
          预算年度默认取申请/填制日期年份,可按行修改;完成日期列仅 v2(申请日期版)导出有值。
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
              disabled={selected.size === 0 || multiTargetV3}
              title={multiTargetV3 ? '勾选行属于不同项目,请按行指定科目' : undefined}
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

export const isSettlementTemplate = (v: string) => isSettlementTemplateVersion(v);
