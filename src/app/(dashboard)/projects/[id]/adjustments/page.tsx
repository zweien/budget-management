'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { format } from 'date-fns';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  AdjustmentPreviewDialog,
  type AdjustmentPreviewTarget,
} from '@/components/adjustments/AdjustmentPreviewDialog';

import { apiFetch } from '@/lib/api/client';
import { D } from '@/lib/decimal';
import { cn } from '@/lib/utils';
import {
  AdjustmentDetailSheet,
  STATUS_BADGE,
  STATUS_LABEL,
} from '@/components/adjustments/AdjustmentDetailSheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AmountInput } from '@/components/ui/AmountInput';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/layout/empty-state';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/ui/combobox';
import { MoneyText } from '@/components/ui/MoneyText';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

// ------------------------------------------------------------
// 枚举(本地定义,不引 @prisma/client)。
// ------------------------------------------------------------
// ------------------------------------------------------------
// 类型
// ------------------------------------------------------------
interface ProjectDetail {
  id: string;
  code: string;
  name: string;
  /** 预算类型(§包干制):LUMP_SUM 无科目总预算层,表单隐藏总维度输入(恒 0)。 */
  budgetMode?: string;
  /** 服务端随详情下发:当前用户是否可编辑该项目(查看态门控)。 */
  canEdit?: boolean;
}

interface InitialBudgetState {
  id?: string;
  status?: string;
}

/** 科目预算基线(原总预算 + 原年度预算 + 剩余可分配额)。 */
interface SubjectBaseline {
  subjectId: string;
  code: string;
  name: string;
  totalCurrent: string;
  annualCurrent: string;
  /** 追加下达模式每行上限 = 总预算 − 历年已分配年度合计。 */
  remaining: string;
}

interface BaselineResponse {
  year: number;
  baseline: SubjectBaseline[];
}

/** 调整明细行(对应后端 BudgetAdjustmentLine)。 */
interface AdjustmentLine {
  id: string;
  year: number;
  subjectId: string | null;
  totalAdjustment: string;
  annualAdjustment: string;
  newSubjectName?: string | null;
  newSubjectParentId?: string | null;
}

/** 调整单。 */
interface AdjustmentRow {
  id: string;
  year: number;
  kind?: 'ADJUST' | 'ALLOCATE';
  expandTotals?: boolean;
  status: string;
  totalReason: string | null;
  annualReason: string | null;
  applicantId: string;
  createdAt: string;
  lines: AdjustmentLine[];
}

interface ListResponse {
  adjustments: AdjustmentRow[];
}

/** 表单内的明细编辑行。 */
interface EditLine {
  key: string;
  subjectId: string | null;
  // 新增科目模式(isNew=true 时):name + 父节点。
  isNew: boolean;
  newName: string;
  newParentId: string | null;
  totalAdjustment: string;
  annualAdjustment: string;
}

/** 科目树节点(用于父节点下拉)。 */
interface SubjectNode {
  id: string;
  name: string;
  parentId: string | null;
  level: number;
  isLeaf: boolean;
}

let keySeq = 0;
const genKey = () => `line-${++keySeq}`;

/** 新增科目 Select 哨兵值。 */
const NEW_SUBJECT = '__NEW__';
/** 新增科目父节点哨兵:作为一级科目(顶层,无父节点)。 */
const NEW_ROOT = '__NEW_ROOT__';

function yearOptions(): number[] {
  const now = new Date().getFullYear();
  return [now, now - 1, now - 2, now - 3, now - 4];
}

function formatDateTime(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd HH:mm');
}

/** 字符串金额 → 显示带正负号(用于明细摘要)。 */
function signedAmount(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0.00';
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

const emptyLine = (): EditLine => ({
  key: genKey(),
  subjectId: null,
  isNew: false,
  newName: '',
  newParentId: null,
  totalAdjustment: '',
  annualAdjustment: '',
});

export default function AdjustmentsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [budgetStatus, setBudgetStatus] = useState<string | null>(null);
  const [adjustments, setAdjustments] = useState<AdjustmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  // 列表 / 表单 视图切换。
  const [mode, setMode] = useState<'list' | 'form'>('list');

  // 表单状态。
  const [formYear, setFormYear] = useState<number>(() => new Date().getFullYear());
  // 调整单类型:ADJUST=调剂(零和);ALLOCATE=追加下达(净增,可新建年度账)。
  const [formKind, setFormKind] = useState<'ADJUST' | 'ALLOCATE'>('ADJUST');
  // 仅追加下达:追加的同时调增科目总预算与项目总预算(新经费入账);缺省=池内分配。
  const [formExpandTotals, setFormExpandTotals] = useState(false);
  const [baseline, setBaseline] = useState<SubjectBaseline[]>([]);
  const [formLines, setFormLines] = useState<EditLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [baselineLoading, setBaselineLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 科目全树(用于新增科目的父节点下拉:非叶 + 无预算叶)。
  const [subjectTree, setSubjectTree] = useState<SubjectNode[]>([]);
  // 调整原因:原生受控 textarea(React 受控原生元素无中文输入法问题,
  // 历史问题源于 antd TextArea 的内部重格式化)。
  const [totalReason, setTotalReason] = useState('');
  const [annualReason, setAnnualReason] = useState('');

  // 只读明细 Sheet。
  const [detailTarget, setDetailTarget] = useState<AdjustmentRow | null>(null);
  /** 在线预览目标(§issue17):dim = 按钮点开的初始维度,窗口内仍可切换。 */
  const [previewTarget, setPreviewTarget] = useState<AdjustmentPreviewTarget | null>(null);
  // 删除确认。
  const [deleteTarget, setDeleteTarget] = useState<AdjustmentRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  /** 初始预算是否已生效(发起调整的前提)。 */
  const isEffective = budgetStatus === 'APPROVED';

  // §包干制(LUMP_SUM):无科目总预算层——总维度调整额恒 0(输入隐藏),
  // 池内分配的容量护栏由服务端按「项目总预算 − 历年已分配年度预算」项目级校验。
  const isLumpSum = project?.budgetMode === 'LUMP_SUM';

  const baselineMap = useMemo(() => new Map(baseline.map((b) => [b.subjectId, b])), [baseline]);

  const subjectName = (subjectId: string | null): string => {
    if (!subjectId) return '—';
    return baselineMap.get(subjectId)?.name ?? subjectId.slice(0, 8);
  };

  // 拉取项目头 + 初始预算状态(仅一次)。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [proj, budget] = await Promise.all([
          apiFetch<ProjectDetail>(`/api/projects/${projectId}`),
          apiFetch<InitialBudgetState | null>(`/api/projects/${projectId}/initial-budget`).catch(
            () => null,
          ),
        ]);
        if (cancelled) return;
        setProject(proj);
        setBudgetStatus(budget?.status ?? null);
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : '加载项目信息失败';
          setFatal(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 拉取调整单列表。
  const reload = async () => {
    try {
      const [listRes, baseRes] = await Promise.all([
        apiFetch<ListResponse>(`/api/projects/${projectId}/adjustments`),
        // 拉一次科目基线(任意年度),用于列表/明细里 subjectId → 科目名称。
        apiFetch<BaselineResponse>(
          `/api/projects/${projectId}/adjustments/baseline?year=${new Date().getFullYear()}`,
        ).catch(() => null),
      ]);
      setAdjustments(listRes.adjustments);
      if (baseRes && baseline.length === 0) {
        setBaseline(baseRes.baseline);
      }
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await reload();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 拉取某年度的科目预算基线(原总预算 + 原年度预算)。
  const loadBaseline = async (year: number) => {
    setBaselineLoading(true);
    try {
      const { baseline: b } = await apiFetch<BaselineResponse>(
        `/api/projects/${projectId}/adjustments/baseline?year=${year}`,
      );
      setBaseline(b);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setBaselineLoading(false);
    }
  };

  // 拉取科目全树(用于新增科目的父节点下拉)。
  const loadSubjectTree = async () => {
    try {
      const { subjects } = await apiFetch<{ subjects: SubjectNode[] }>(
        `/api/projects/${projectId}/subjects`,
      );
      setSubjectTree(subjects);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    }
  };

  /** 父节点候选:一级科目哨兵 + 全部非叶科目 + 无预算的叶科目(挂上子科目后即转为非叶;
   *  已有预算的叶科目被服务端拒绝,其预算基数即明细行科目候选)。 */
  const parentOptions = useMemo(() => {
    const budgeted = new Set(baseline.map((s) => s.subjectId));
    return [
      { value: NEW_ROOT, label: '★ 作为一级科目(顶层)', keywords: '一级 顶层 根' },
      ...subjectTree
        .filter((s) => !s.isLeaf || !budgeted.has(s.id))
        .map((s) => ({
          value: s.id,
          label: `${'　'.repeat(Math.max(0, s.level - 1))}${s.name}`,
          keywords: s.name,
        })),
    ];
  }, [subjectTree, baseline]);

  /** 明细行科目候选:叶科目(名称/编号可搜)+ 新增科目哨兵项。 */
  const subjectPickOptions = useMemo(
    () => [
      ...baseline.map((s) => ({ value: s.subjectId, label: s.name, keywords: s.code })),
      { value: NEW_SUBJECT, label: '➕ 新增科目...', keywords: '新增' },
    ],
    [baseline],
  );

  // ------------------------------------------------------------
  // 表单操作
  // ------------------------------------------------------------
  const openCreate = async () => {
    setEditingId(null);
    setFormKind('ADJUST');
    setFormExpandTotals(false);
    const y = new Date().getFullYear();
    setFormYear(y);
    setTotalReason('');
    setAnnualReason('');
    await Promise.all([loadBaseline(y), loadSubjectTree()]);
    setFormLines([emptyLine()]);
    setMode('form');
  };

  const openEdit = async (row: AdjustmentRow) => {
    setEditingId(row.id);
    setFormKind(row.kind === 'ALLOCATE' ? 'ALLOCATE' : 'ADJUST');
    setFormExpandTotals(row.expandTotals === true);
    setFormYear(row.year);
    setTotalReason(row.totalReason ?? '');
    setAnnualReason(row.annualReason ?? '');
    await Promise.all([loadBaseline(row.year), loadSubjectTree()]);
    setFormLines(
      row.lines.map((l) => ({
        key: genKey(),
        subjectId: l.subjectId,
        isNew: !l.subjectId,
        newName: l.newSubjectName ?? '',
        newParentId: l.newSubjectParentId ?? null,
        totalAdjustment: l.totalAdjustment,
        annualAdjustment: l.annualAdjustment,
      })),
    );
    setMode('form');
  };

  const cancelForm = () => {
    setMode('list');
    setEditingId(null);
  };

  const updateLine = (key: string, patch: Partial<EditLine>) => {
    setFormLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  };

  const addLine = () => {
    setFormLines((prev) => [...prev, emptyLine()]);
  };

  const removeLine = (key: string) => {
    setFormLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));
  };

  const handleYearChange = async (y: number) => {
    setFormYear(y);
    await loadBaseline(y);
  };

  /**
   * 构建并校验 payload。
   * @param requireBalance 是否强制提交级校验(草稿=false)。
   *   ADJUST:双维度收支平衡(Σ=0),草稿允许留空按 0 处理。
   *   ALLOCATE:每行 annual ≥ 0 且需填写、Σ > 0、每行 ≤ 剩余可分配额;total 恒为 0。
   */
  const buildPayload = (
    requireBalance: boolean,
  ): { ok: boolean; payload?: unknown; error?: string } => {
    // 有效行:现有科目(subjectId)或新增科目(isNew 且 newName 填写;
    // newParentId 可缺省 = 作为一级科目,NEW_ROOT 哨兵)。
    const valid = formLines.filter(
      (l) => l.subjectId || (l.isNew && l.newName.trim() && l.newParentId),
    );
    if (valid.length === 0) {
      return { ok: false, error: '请至少选择一个科目或新增科目' };
    }

    if (formKind === 'ALLOCATE') {
      // 提交级校验(requireBalance=true):行值 ≥ 0、合计 > 0、同科目合计 ≤ 剩余可分配额、
      // 新增科目行 > 0。草稿(=false)允许留空按 0 落库的中间态,校验推迟到提交。
      if (requireBalance) {
        for (const [i, l] of valid.entries()) {
          if (l.annualAdjustment === '') {
            return { ok: false, error: `第 ${i + 1} 行的「本年度下达额」需填写(追加单不可调减)` };
          }
          if ((Number(l.annualAdjustment) || 0) < 0) {
            return {
              ok: false,
              error: `第 ${i + 1} 行不能为负——要减预算请改用「调剂」类型(有额度护栏)`,
            };
          }
          if (l.isNew && (Number(l.annualAdjustment) || 0) <= 0) {
            return {
              ok: false,
              error: `第 ${i + 1} 行新增科目"${l.newName.trim()}"的分配额须大于 0(不接受零额建档)`,
            };
          }
        }
        // 同科目多行合并后再比剩余额度(与后端聚合口径一致)。
        // §包干制:无科目总预算池,服务端按项目级未分配额度校验,前端跳过逐科目护栏。
        if (!formExpandTotals && !isLumpSum) {
          const sumBySubject = new Map<string, number>();
          for (const l of valid) {
            if (l.isNew || !l.subjectId) continue;
            sumBySubject.set(
              l.subjectId,
              (sumBySubject.get(l.subjectId) ?? 0) + (Number(l.annualAdjustment) || 0),
            );
          }
          for (const [sid, sum] of sumBySubject) {
            const remaining = Number(baselineMap.get(sid)?.remaining ?? '0');
            if (sum > remaining + 1e-9) {
              return {
                ok: false,
                error: `${baselineMap.get(sid)?.name ?? '科目'} 合计下达 ${sum.toFixed(2)} 超出剩余可分配额度 ${remaining.toFixed(2)}(总预算 − 历年已分配)`,
              };
            }
          }
        }
        const allocSum = valid.reduce((a, l) => a + (Number(l.annualAdjustment) || 0), 0);
        if (!(allocSum > 0.001)) {
          return { ok: false, error: '追加下达至少需要一行正数金额' };
        }
      }
      const lines = valid.map((l) => ({
        totalAdjustment: '0',
        annualAdjustment: l.annualAdjustment === '' ? '0' : Number(l.annualAdjustment).toFixed(2),
        ...(l.isNew
          ? {
              subjectId: null,
              newSubjectName: l.newName.trim(),
              newSubjectParentId: l.newParentId === NEW_ROOT ? null : l.newParentId,
            }
          : { subjectId: l.subjectId }),
      }));
      return {
        ok: true,
        payload: {
          year: formYear,
          kind: 'ALLOCATE',
          expandTotals: formExpandTotals || undefined,
          totalReason: null,
          annualReason: annualReason.trim() || null,
          lines,
        },
      };
    }

    const sumField = (sel: 'totalAdjustment' | 'annualAdjustment') =>
      valid.reduce((a, l) => a + (Number(l[sel]) || 0), 0);
    if (requireBalance) {
      // 提交时:每行调整额必须明确填写(可填 0)。§包干制:总维度恒 0(输入隐藏),只要求年度。
      for (const l of valid) {
        if (!isLumpSum && l.totalAdjustment === '') {
          return { ok: false, error: '每行的「总预算调整额」「年度调整额」都需填写(可填 0)' };
        }
        if (l.annualAdjustment === '') {
          return { ok: false, error: '每行的「年度调整额」需填写(可填 0)' };
        }
      }
      if (!isLumpSum) {
        const totalSum = sumField('totalAdjustment');
        if (Math.abs(totalSum) > 0.001) {
          return { ok: false, error: `总预算维度调整不平衡:合计 ${totalSum.toFixed(2)} ≠ 0` };
        }
      }
      const annualSum = sumField('annualAdjustment');
      if (Math.abs(annualSum) > 0.001) {
        return { ok: false, error: `年度预算维度调整不平衡:合计 ${annualSum.toFixed(2)} ≠ 0` };
      }
    }
    const lines = valid.map((l) => {
      const base = {
        // 草稿允许留空,按 0 落库;提交时已保证非空。
        // §包干制:总维度恒 0(无科目总预算层,服务端同样拒绝非 0)。
        totalAdjustment: isLumpSum
          ? '0'
          : l.totalAdjustment === ''
            ? '0'
            : Number(l.totalAdjustment).toFixed(2),
        annualAdjustment: l.annualAdjustment === '' ? '0' : Number(l.annualAdjustment).toFixed(2),
      };
      if (l.isNew) {
        return {
          ...base,
          subjectId: null,
          newSubjectName: l.newName.trim(),
          newSubjectParentId: l.newParentId === NEW_ROOT ? null : l.newParentId,
        };
      }
      return { ...base, subjectId: l.subjectId };
    });
    return {
      ok: true,
      payload: {
        year: formYear,
        kind: 'ADJUST',
        totalReason: totalReason.trim() || null,
        annualReason: annualReason.trim() || null,
        lines,
      },
    };
  };

  const handleSaveDraft = async () => {
    // 草稿:不校验平衡,允许保存未完成的中间态。
    const { ok, payload, error } = buildPayload(false);
    if (!ok) {
      toast.warning(error);
      return;
    }
    setSubmitting(true);
    try {
      if (editingId) {
        await apiFetch(`/api/projects/${projectId}/adjustments/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch(`/api/projects/${projectId}/adjustments`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      toast.success('已保存草稿');
      setMode('list');
      setEditingId(null);
      await reload();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveAndSubmit = async () => {
    // 提交:强制双维度收支平衡。
    const { ok, payload, error } = buildPayload(true);
    if (!ok) {
      toast.warning(error);
      return;
    }
    setSubmitting(true);
    try {
      // 编辑模式(草稿/已驳回):保存到原单并提交原单,不再另建新单(§codex P1)。
      if (editingId) {
        await apiFetch(`/api/projects/${projectId}/adjustments/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        await apiFetch(`/api/projects/${projectId}/adjustments/${editingId}/submit`, {
          method: 'POST',
        });
      } else {
        const { adjustment } = await apiFetch<{ adjustment: AdjustmentRow }>(
          `/api/projects/${projectId}/adjustments`,
          { method: 'POST', body: JSON.stringify(payload) },
        );
        await apiFetch(`/api/projects/${projectId}/adjustments/${adjustment.id}/submit`, {
          method: 'POST',
        });
      }
      toast.success('已提交审批,可在审批中心查看进度');
      setMode('list');
      setEditingId(null);
      await reload();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const submitRow = async (row: AdjustmentRow) => {
    try {
      await apiFetch(`/api/projects/${projectId}/adjustments/${row.id}/submit`, {
        method: 'POST',
      });
      toast.success('已提交审批');
      await reload();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/projects/${projectId}/adjustments/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      toast.success('已删除草稿');
      setDeleteTarget(null);
      await reload();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setDeleting(false);
    }
  };

  // ------------------------------------------------------------
  // 自动生成调整原因说明
  // ------------------------------------------------------------
  /** 元字符串 → 精确万元(不取整);原值与绝对值都以 Decimal 字符串给出(不经 Number,防大额丢精度)。 */
  function yuanToWanParts(yuanStr: string): { wan: string; abs: string } {
    const d = new D(yuanStr || '0').div(10000);
    if (d.isZero()) return { wan: '0', abs: '0' };
    return { wan: d.toString(), abs: d.abs().toString() };
  }

  /**
   * 按维度生成调整原因说明。
   * 规则:逐品名(明细行)描述,原预算为0的调增用"新增",否则用"调增/调减";
   * 金额用精确万元(不取整);该维度无任何调整(全0或无行)→ 返回空串。
   */
  const generateReason = (dim: 'total' | 'annual'): string => {
    const field = dim === 'total' ? 'totalAdjustment' : 'annualAdjustment';
    const parts: string[] = [];
    for (const l of formLines) {
      const amt = Number(l[field]) || 0;
      if (amt === 0) continue; // 该维度此行无调整
      const { wan, abs } = yuanToWanParts(l[field]);
      // 新增科目行:原预算必为 0,调增即"新增"。
      if (l.isNew) {
        const name = l.newName.trim() || '新科目';
        if (amt > 0) {
          parts.push(`新增${name}预算${wan}万元`);
        } else {
          parts.push(`${name}预算调减${abs}万元`);
        }
        continue;
      }
      if (!l.subjectId) continue;
      const base = baselineMap.get(l.subjectId);
      const productName = base?.name ?? '';
      const originCurrent =
        dim === 'total' ? Number(base?.totalCurrent ?? 0) : Number(base?.annualCurrent ?? 0);
      if (amt > 0 && originCurrent === 0) {
        parts.push(`新增${productName}预算${wan}万元`);
      } else if (amt > 0) {
        parts.push(`${productName}预算调增${wan}万元`);
      } else {
        parts.push(`${productName}预算调减${abs}万元`);
      }
    }
    if (parts.length === 0) return '';
    return `根据项目研究需要，对经费预算进行调整。${parts.join('，')}。`;
  };

  /** 一键生成两个维度原因(覆盖现有内容)。§包干制:总维度恒 0,只生成年度原因。 */
  const handleAutoGenerate = () => {
    const t = isLumpSum ? '' : generateReason('total');
    const a = generateReason('annual');
    setTotalReason(t);
    setAnnualReason(a);
    toast.success(t || a ? '已生成调整原因说明,可继续编辑' : '当前调整无变动,未生成说明');
  };

  // ------------------------------------------------------------
  // 汇总(实时平衡校验)
  // ------------------------------------------------------------
  const summary = useMemo(() => {
    const sumField = (sel: 'totalAdjustment' | 'annualAdjustment') =>
      formLines.reduce((a, l) => a + (Number(l[sel]) || 0), 0);
    const totalSum = sumField('totalAdjustment');
    const annualSum = sumField('annualAdjustment');
    return {
      totalSum,
      annualSum,
      balanced: Math.abs(totalSum) < 0.001 && Math.abs(annualSum) < 0.001,
    };
  }, [formLines]);

  /** 追加下达就绪:有正数行,且(池内模式)每科目合计下达不超剩余可分配额。
   *  §包干制:无科目总预算池,逐科目护栏不适用(服务端按项目级额度校验)。 */
  const allocateReady = useMemo(() => {
    const lines = formLines.filter(
      (l) => l.subjectId || (l.isNew && l.newName.trim() && l.newParentId),
    );
    if (lines.length === 0) return false;
    const sumBySubject = new Map<string, number>();
    let hasPositive = false;
    for (const l of lines) {
      const v = Number(l.annualAdjustment) || 0;
      if (v < 0) return false;
      if (v > 0) hasPositive = true;
      if (!l.isNew && l.subjectId) {
        sumBySubject.set(l.subjectId, (sumBySubject.get(l.subjectId) ?? 0) + v);
      }
    }
    if (!hasPositive) return false;
    if (formExpandTotals || isLumpSum) return true;
    for (const [sid, sum] of sumBySubject) {
      const remaining = Number(baselineMap.get(sid)?.remaining ?? '0');
      if (sum > remaining + 1e-9) return false;
    }
    return true;
  }, [formLines, baselineMap, formExpandTotals, isLumpSum]);

  // ------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------
  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (fatal || !project) {
    return (
      <Alert variant="error">
        <AlertTitle>加载失败</AlertTitle>
        <AlertDescription>{fatal}</AlertDescription>
      </Alert>
    );
  }

  // ============== 表单视图 ==============
  if (mode === 'form') {
    /** 计算调整后值 = 原 + 调整额。 */
    const afterTotal = (r: EditLine): string => {
      const base = r.subjectId ? Number(baselineMap.get(r.subjectId)?.totalCurrent ?? 0) : 0;
      const adj = Number(r.totalAdjustment) || 0;
      return (base + adj).toFixed(2);
    };
    const afterAnnual = (r: EditLine): string => {
      const base = r.subjectId ? Number(baselineMap.get(r.subjectId)?.annualCurrent ?? 0) : 0;
      const adj = Number(r.annualAdjustment) || 0;
      return (base + adj).toFixed(2);
    };

    const sumOrigTotal = formLines.reduce(
      (a, l) => a + (l.isNew ? 0 : Number(baselineMap.get(l.subjectId ?? '')?.totalCurrent ?? 0)),
      0,
    );
    const sumOrigAnnual = formLines.reduce(
      (a, l) => a + (l.isNew ? 0 : Number(baselineMap.get(l.subjectId ?? '')?.annualCurrent ?? 0)),
      0,
    );

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-[-0.3px]">
            {editingId
              ? '编辑调整单'
              : formKind === 'ALLOCATE'
                ? '发起预算追加下达'
                : '发起预算调整'}
          </h2>
          <Button variant="outline" onClick={cancelForm}>
            取消
          </Button>
        </div>

        {project.canEdit === false && (
          <Alert variant="info">
            <AlertDescription>
              你只有查看权限,表单不可保存。如需编辑,请联系管理员将你设为该项目负责人。
            </AlertDescription>
          </Alert>
        )}

        {/* 类型 + 年度 + 原因(原生受控 textarea,无输入法问题) */}
        <div className="grid gap-4 rounded-lg border border-border bg-card p-4 shadow-l2 lg:grid-cols-[260px_200px_1fr]">
          <div className="grid content-start gap-1.5">
            <Label>调整类型</Label>
            <Select
              value={formKind}
              onValueChange={(v) => {
                setFormKind(v === 'ALLOCATE' ? 'ALLOCATE' : 'ADJUST');
                // 切到追加时把历史负数清掉,避免提交被拒(追加不可为负)。
                if (v === 'ALLOCATE') {
                  setFormLines((prev) =>
                    prev.map((l) => ({
                      ...l,
                      totalAdjustment: '',
                      annualAdjustment:
                        l.annualAdjustment && Number(l.annualAdjustment) < 0
                          ? ''
                          : l.annualAdjustment,
                    })),
                  );
                }
              }}
              disabled={baselineLoading}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ADJUST">调剂(零和挪钱)</SelectItem>
                <SelectItem value="ALLOCATE">追加下达(净增)</SelectItem>
              </SelectContent>
            </Select>
            {formKind === 'ALLOCATE' && (
              <div className="mt-1 grid gap-1.5">
                <label className="flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                  <Checkbox
                    checked={formExpandTotals}
                    onCheckedChange={(v) => setFormExpandTotals(v === true)}
                    aria-label="同步调增科目总预算与项目总预算"
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-foreground">新经费入账</span>
                    (同步调增科目总预算与项目总预算)
                    <br />
                    勾选后不受「剩余可分配额」限制;不勾选则只把科目既有总预算分批落地到年份,各层总额不变。
                  </span>
                </label>
                <p className="text-xs leading-relaxed text-mute">
                  为选定年度下达此前未分配的预算;该年未建账会在审批通过时自动创建。调减请改用「调剂」。
                </p>
              </div>
            )}
          </div>
          <div className="grid content-start gap-1.5">
            <Label>{formKind === 'ALLOCATE' ? '下达年度' : '调整年度'}</Label>
            {formKind === 'ALLOCATE' ? (
              // 追加模式可任意年份(含未来新年度),数字输入而非近五年下拉。
              <Input
                type="number"
                min={1900}
                max={9999}
                value={String(formYear)}
                onChange={(e) => void handleYearChange(Number(e.target.value))}
                onBlur={() => void loadBaseline(formYear)}
                disabled={baselineLoading}
              />
            ) : (
              <Select
                value={String(formYear)}
                onValueChange={(v) => void handleYearChange(Number(v))}
                disabled={baselineLoading}
              >
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
            )}
          </div>
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label>调整原因</Label>
              <Button variant="outline" size="sm" onClick={handleAutoGenerate}>
                <Sparkles />
                自动生成原因说明
              </Button>
              <span className="text-xs text-mute">根据当前调整明细自动生成,生成后可手动编辑</span>
            </div>
            {/* §包干制:无科目总预算层,总维度原因不适用(隐藏)。 */}
            {formKind !== 'ALLOCATE' && !isLumpSum && (
              <div className="grid gap-1.5">
                <Label className="text-xs font-normal text-muted-foreground">总预算调整原因</Label>
                <Textarea
                  className="min-h-14 resize-y"
                  placeholder="总预算调整原因说明(导出总预算调整文档用)"
                  value={totalReason}
                  onChange={(e) => setTotalReason(e.target.value)}
                />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label className="text-xs font-normal text-muted-foreground">年度预算调整原因</Label>
              <Textarea
                className="min-h-14 resize-y"
                placeholder={
                  formKind === 'ALLOCATE'
                    ? '追加下达原因说明(如:第二批经费到账,下达下一年度预算)'
                    : '年度预算调整原因说明(导出年度预算调整文档用)'
                }
                value={annualReason}
                onChange={(e) => setAnnualReason(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* 调整明细 */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">调整明细</h3>
          <Button variant="outline" size="sm" onClick={addLine}>
            <Plus />
            新增科目行
          </Button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              {formKind === 'ALLOCATE' ? (
                <TableRow className="hover:bg-transparent">
                  <TableHead className="min-w-52">科目</TableHead>
                  <TableHead className="w-32 text-right">剩余可分配额</TableHead>
                  <TableHead className="w-36">本年度下达额</TableHead>
                  <TableHead className="w-32 text-right">下达后年度预算</TableHead>
                  <TableHead className="w-14" />
                </TableRow>
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableHead className="min-w-52">科目</TableHead>
                  <TableHead className="w-28 text-right">原总预算</TableHead>
                  <TableHead className="w-32">总预算调整额</TableHead>
                  <TableHead className="w-32 text-right">调整后总预算</TableHead>
                  <TableHead className="w-28 text-right">原年度预算</TableHead>
                  <TableHead className="w-32">年度调整额</TableHead>
                  <TableHead className="w-32 text-right">调整后年度预算</TableHead>
                  <TableHead className="w-14" />
                </TableRow>
              )}
            </TableHeader>
            <TableBody>
              {formLines.map((r) => (
                <TableRow key={r.key} className="">
                  <TableCell>
                    {r.isNew ? (
                      <div className="grid min-w-48 gap-1.5">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="warning">新</Badge>
                          <input
                            className="h-7 w-full min-w-24 rounded-md border border-input bg-card px-2 text-sm outline-none placeholder:text-mute focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                            placeholder="新科目名称"
                            value={r.newName}
                            onChange={(e) => updateLine(r.key, { newName: e.target.value })}
                          />
                        </div>
                        <Combobox
                          className="w-full"
                          options={parentOptions}
                          value={r.newParentId ?? undefined}
                          onChange={(v) => updateLine(r.key, { newParentId: v })}
                          placeholder="选择父节点"
                          searchPlaceholder="输入名称筛选…"
                          emptyText="无可选父节点"
                        />
                      </div>
                    ) : (
                      <Combobox
                        className="w-full min-w-40"
                        options={subjectPickOptions}
                        value={r.subjectId ?? undefined}
                        onChange={(v) => {
                          if (v === NEW_SUBJECT) {
                            updateLine(r.key, { isNew: true, subjectId: null });
                          } else {
                            updateLine(r.key, { subjectId: v });
                          }
                        }}
                        placeholder="选择科目"
                        searchPlaceholder="输入名称或编号筛选…"
                        emptyText="无匹配科目"
                      />
                    )}
                  </TableCell>
                  {formKind === 'ALLOCATE' ? (
                    <>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {r.isNew
                          ? '∞(新科目立账)'
                          : r.subjectId
                            ? isLumpSum
                              ? '—' // §包干制:无科目总预算池,容量由服务端按项目级额度校验。
                              : (baselineMap.get(r.subjectId)?.remaining ?? '0.00')
                            : '—'}
                      </TableCell>
                      <TableCell>
                        <AmountInput
                          size="sm"
                          value={r.annualAdjustment}
                          onChange={(v) => updateLine(r.key, { annualAdjustment: v ?? '' })}
                        />
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {r.isNew
                          ? (Number(r.annualAdjustment) || 0).toFixed(2)
                          : r.subjectId
                            ? afterAnnual(r)
                            : '—'}
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {r.isNew
                          ? '0.00'
                          : r.subjectId
                            ? (baselineMap.get(r.subjectId)?.totalCurrent ?? '0.00')
                            : '—'}
                      </TableCell>
                      <TableCell>
                        {/* §包干制:无科目总预算层,总维度调整恒 0(只读展示)。 */}
                        {isLumpSum ? (
                          <span className="block text-sm text-mute tabular-nums">0.00(包干)</span>
                        ) : (
                          <AmountInput
                            size="sm"
                            allowNegative
                            value={r.totalAdjustment}
                            onChange={(v) => updateLine(r.key, { totalAdjustment: v ?? '' })}
                          />
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {isLumpSum
                          ? '0.00'
                          : r.isNew
                            ? (Number(r.totalAdjustment) || 0).toFixed(2)
                            : r.subjectId
                              ? afterTotal(r)
                              : '—'}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {r.isNew
                          ? '0.00'
                          : r.subjectId
                            ? (baselineMap.get(r.subjectId)?.annualCurrent ?? '0.00')
                            : '—'}
                      </TableCell>
                      <TableCell>
                        <AmountInput
                          size="sm"
                          allowNegative
                          value={r.annualAdjustment}
                          onChange={(v) => updateLine(r.key, { annualAdjustment: v ?? '' })}
                        />
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {r.isNew
                          ? (Number(r.annualAdjustment) || 0).toFixed(2)
                          : r.subjectId
                            ? afterAnnual(r)
                            : '—'}
                      </TableCell>
                    </>
                  )}
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-mute hover:text-error-deep"
                      aria-label="删除该行"
                      onClick={() => removeLine(r.key)}
                      disabled={formLines.length <= 1}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              {formKind === 'ALLOCATE' ? (
                <TableRow className="">
                  <TableCell className="font-semibold">合计下达</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">—</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {summary.annualSum.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">—</TableCell>
                  <TableCell />
                </TableRow>
              ) : (
                <TableRow className="">
                  <TableCell className="font-semibold">合计</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {sumOrigTotal.toFixed(2)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-semibold tabular-nums',
                      Math.abs(summary.totalSum) > 0.001 && 'text-error-deep',
                    )}
                  >
                    {summary.totalSum.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {(sumOrigTotal + summary.totalSum).toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {sumOrigAnnual.toFixed(2)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-semibold tabular-nums',
                      Math.abs(summary.annualSum) > 0.001 && 'text-error-deep',
                    )}
                  >
                    {summary.annualSum.toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {(sumOrigAnnual + summary.annualSum).toFixed(2)}
                  </TableCell>
                  <TableCell />
                </TableRow>
              )}
            </TableFooter>
          </Table>
        </div>

        {formKind === 'ALLOCATE' ? (
          <Alert variant={allocateReady ? 'success' : 'error'}>
            <AlertDescription>
              本年度合计下达{' '}
              <MoneyText
                value={summary.annualSum.toFixed(2)}
                riskOnNegative={false}
                className="inline"
              />
              ;审批通过后自动创建未建账科目的年度预算。
              {formExpandTotals
                ? '已选「新经费入账」:科目总预算与项目总预算将同步调增。'
                : '池内分配:各层总额不变,仅把科目既有总预算落地到年份。'}
              {allocateReady
                ? ' ✓ 可提交'
                : ' · 至少一行正数金额,且(池内)同科目合计不超剩余可分配额'}
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant={summary.balanced ? 'success' : 'error'}>
            <AlertDescription>
              汇总:总预算调整合计{' '}
              <MoneyText
                value={summary.totalSum.toFixed(2)}
                riskOnNegative={false}
                className="inline"
              />{' '}
              · 年度调整合计{' '}
              <MoneyText
                value={summary.annualSum.toFixed(2)}
                riskOnNegative={false}
                className="inline"
              />
              {summary.balanced
                ? ' · 两维度均已平衡 ✓ 可提交'
                : ' · 调整合计须为 0 才可提交(原预算=调整后预算)'}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={submitting || project.canEdit === false}
            onClick={handleSaveDraft}
          >
            保存草稿
          </Button>
          <Button disabled={submitting || project.canEdit === false} onClick={handleSaveAndSubmit}>
            {submitting ? '提交中…' : '保存并提交'}
          </Button>
          <Button variant="ghost" onClick={cancelForm}>
            取消
          </Button>
        </div>
      </div>
    );
  }

  // ============== 列表视图 ==============
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-[-0.3px]">调整单列表</h2>
        <Button
          onClick={() => void openCreate()}
          disabled={!isEffective || project?.canEdit === false}
          title={project?.canEdit === false ? '你只有查看权限' : undefined}
        >
          <Plus />
          发起调整
        </Button>
      </div>

      {!isEffective && (
        <Alert variant="warning">
          <AlertTitle>初始预算尚未生效,暂无法发起预算调整</AlertTitle>
          <AlertDescription>请先完成初始预算编制并审批通过,再进行预算调整。</AlertDescription>
        </Alert>
      )}

      {adjustments.length === 0 ? (
        <EmptyState title={isEffective ? '暂无调整单,点击「发起调整」' : '暂无调整单'} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-20">年度</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead>明细摘要</TableHead>
                <TableHead>原因</TableHead>
                <TableHead className="w-40">创建时间</TableHead>
                <TableHead className="w-80">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {adjustments.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="tabular-nums">
                    {row.year}
                    {row.kind === 'ALLOCATE' && (
                      <Badge variant="outline" className="ml-1 align-middle">
                        追加
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[row.status] ?? 'secondary'}>
                      {STATUS_LABEL[row.status] ?? row.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {!row.lines?.length ? (
                      <span className="text-mute">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                        {row.lines.slice(0, 2).map((l) => (
                          <span key={l.id}>
                            <span className="font-medium">{subjectName(l.subjectId)}</span>
                            <span className="text-muted-foreground tabular-nums">
                              {' '}
                              总{signedAmount(l.totalAdjustment)} 年
                              {signedAmount(l.annualAdjustment)}
                            </span>
                          </span>
                        ))}
                        {row.lines.length > 2 && (
                          <span className="text-mute">+{row.lines.length - 2} 行</span>
                        )}
                      </span>
                    )}
                  </TableCell>
                  <TableCell
                    className="max-w-48 truncate"
                    title={[
                      row.totalReason && `总:${row.totalReason}`,
                      row.annualReason && `年:${row.annualReason}`,
                    ]
                      .filter(Boolean)
                      .join(' / ')}
                  >
                    {row.totalReason || row.annualReason ? (
                      <span className="text-sm">
                        {[
                          row.totalReason && `总:${row.totalReason}`,
                          row.annualReason && `年:${row.annualReason}`,
                        ]
                          .filter(Boolean)
                          .join(' / ')}
                      </span>
                    ) : (
                      <span className="text-mute">—</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatDateTime(row.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {/* DRAFT 正常编辑/提交/删除;REJECTED 驳回后可修改并再次提交(不可删除,保留流转记录) */}
                      {(row.status === 'DRAFT' || row.status === 'REJECTED') && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => void openEdit(row)}>
                            编辑
                          </Button>
                          <Button size="sm" onClick={() => void submitRow(row)}>
                            提交审批
                          </Button>
                          {row.status === 'DRAFT' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-error-deep hover:bg-error-soft"
                              onClick={() => setDeleteTarget(row)}
                            >
                              删除
                            </Button>
                          )}
                        </>
                      )}
                      {row.status === 'PENDING' && (
                        <span className="px-2 text-sm text-mute">审批中</span>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => setDetailTarget(row)}>
                        明细
                      </Button>
                      {/* 总预算/年度预算:打开预览窗口(§issue17),下载在窗口内完成 */}
                      {row.lines.length > 0 && row.kind !== 'ALLOCATE' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="预览总预算调整审批表,窗口内可下载"
                          onClick={() =>
                            setPreviewTarget({
                              id: row.id,
                              year: row.year,
                              kind: row.kind,
                              dim: 'total',
                            })
                          }
                        >
                          总预算
                        </Button>
                      )}
                      {row.lines.length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="预览年度预算调整审批表,窗口内可下载"
                          onClick={() =>
                            setPreviewTarget({
                              id: row.id,
                              year: row.year,
                              kind: row.kind,
                              dim: 'annual',
                            })
                          }
                        >
                          年度预算
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 删除确认 */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除调整草稿</AlertDialogTitle>
            <AlertDialogDescription>确认删除该调整草稿?此操作不可撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? '删除中…' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 在线预览(§issue17):docx 按模板实时生成,viewer 内可切维度/打印/下载 */}
      <AdjustmentPreviewDialog
        open={!!previewTarget}
        onOpenChange={(o) => !o && setPreviewTarget(null)}
        projectId={projectId}
        adjustment={previewTarget}
      />

      {/* 只读明细 Sheet(§issue15 共享组件:原预算/调整额/调整后 + 合计,懒加载) */}
      <AdjustmentDetailSheet
        open={!!detailTarget}
        onOpenChange={(o) => !o && setDetailTarget(null)}
        projectId={projectId}
        adjustmentId={detailTarget?.id ?? null}
        fallback={
          detailTarget
            ? {
                year: detailTarget.year,
                kind: detailTarget.kind,
                expandTotals: detailTarget.expandTotals,
                status: detailTarget.status,
                totalReason: detailTarget.totalReason,
                annualReason: detailTarget.annualReason,
                createdAt: detailTarget.createdAt,
              }
            : null
        }
      />
    </div>
  );
}
