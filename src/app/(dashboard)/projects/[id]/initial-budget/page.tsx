'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
} from '@tanstack/react-table';
import { ChevronRight, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import { cn } from '@/lib/utils';
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
import { BudgetTreeTable, type LedgerNode } from '@/components/ui/BudgetTreeTable';
import { EmptyState } from '@/components/layout/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { uuidv7 } from '@/lib/id';
import { D } from '@/lib/decimal';

/**
 * §6.2 审批状态(与 Prisma ApprovalStatus 同步;不直接引 @prisma/client 以避免在
 * client bundle 里强引运行时枚举)。
 */
type ApprovalStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  DRAFT: '草稿中',
  PENDING: '待审批',
  APPROVED: '已生效',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
};

/** Badge 语义色遵循 DESIGN.md。 */
const STATUS_BADGE: Record<ApprovalStatus, 'secondary' | 'warning' | 'success' | 'error'> = {
  DRAFT: 'secondary',
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  WITHDRAWN: 'warning',
};

interface ProjectDetail {
  id: string;
  code: string;
  name: string;
}

/** §6 getDraft 返回结构(见 InitialBudgetDraftView)。 */
interface InitialBudgetDraftView {
  id: string;
  projectId: string;
  status: ApprovalStatus;
  projectTotal: string;
  annualBudgets: { year: number; amount: string }[];
  subjects: {
    id: string;
    code: string;
    name: string;
    parentCode: string | null;
    isLeaf: boolean;
    description: string | null;
  }[];
  subjectBudgets: {
    year: number;
    subjectCode: string;
    amount: string;
    unit: string | null;
    quantity: string | null;
    unitPrice: string | null;
  }[];
  subjectTotalBudgets: { subjectCode: string; amount: string }[];
}

/** POST create 的 payload(InitialBudgetPayload)。 */
interface InitialBudgetPayload {
  projectTotal: string;
  annualBudgets: { year: number; amount: string }[];
  subjects: {
    code: string;
    name: string;
    parentCode: string | null;
    isLeaf: boolean;
    description?: string;
  }[];
  /** §enhance:每条年度分配带 unit/quantity/unitPrice;amount = quantity×unitPrice(前端预算,
   *  后端以 decimal.js 重算为唯一真相源)。 */
  subjectBudgets: {
    year: number;
    subjectCode: string;
    amount: string;
    unit: string;
    quantity: string;
    unitPrice: string;
  }[];
  subjectTotalBudgets: { subjectCode: string; amount: string }[];
}

/** §enhance 年度分配明细(单位/数量/单价),以 "subjectCode|year" 为键。 */
interface SubjectBudgetDetail {
  unit: string;
  quantity: string;
  unitPrice: string;
}

/** 表单内一行年度预算编辑。 */
interface AnnualRow {
  key: string;
  year: number;
  amount: string;
}

/** 表单内一行科目编辑。 */
interface SubjectRow {
  key: string;
  code: string;
  name: string;
  parentCode: string | null;
  /** 不再由用户编辑;在提交时由 leafCodes 推导(无任何行把它作为父即叶)。 */
  isLeaf?: boolean;
  description?: string;
}

/** 树形 Table 的数据节点(在 SubjectRow 之上挂 children)。 */
interface SubjectTreeNode extends SubjectRow {
  children?: SubjectTreeNode[];
}

/** 生成一个简易本地唯一 key(用于列表行的稳定 rowKey)。 */
function genKey(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * 预设预算科目模板(PRD 附录 A 默认预算科目示例)。
 * code 用拼音/英文短码(项目内唯一),parentCode 引用同模板内其它 code;isLeaf 标叶节点。
 * 套用后会替换当前科目树(用户可继续增删改)。
 */
interface TemplateSubject {
  code: string;
  name: string;
  parentCode: string | null;
  isLeaf: boolean;
}

const DEFAULT_SUBJECT_TEMPLATE: TemplateSubject[] = [
  { code: 'ZJF', name: '直接费', parentCode: null, isLeaf: false },
  { code: 'SBF', name: '设备费', parentCode: 'ZJF', isLeaf: false },
  { code: 'SBGZF', name: '设备购置费', parentCode: 'SBF', isLeaf: true },
  { code: 'QTSBF', name: '其他设备费', parentCode: 'SBF', isLeaf: true },
  { code: 'CLF', name: '材料费', parentCode: 'ZJF', isLeaf: true },
  { code: 'WBXZF', name: '外部协作费', parentCode: 'ZJF', isLeaf: true },
  { code: 'RLDLF', name: '燃料动力费', parentCode: 'ZJF', isLeaf: true },
  { code: 'HYCLF', name: '会议、差旅费、国际合作交流费', parentCode: 'ZJF', isLeaf: false },
  { code: 'HYF', name: '会议费', parentCode: 'HYCLF', isLeaf: true },
  { code: 'CLF2', name: '差旅费', parentCode: 'HYCLF', isLeaf: true },
  { code: 'GJHZ', name: '国际合作交流费', parentCode: 'HYCLF', isLeaf: true },
  { code: 'CBWX', name: '出版、文献、信息传播、知识产权事务费', parentCode: 'ZJF', isLeaf: true },
  { code: 'LWF', name: '劳务费', parentCode: 'ZJF', isLeaf: true },
  { code: 'ZJZX', name: '专家咨询费', parentCode: 'ZJF', isLeaf: true },
  { code: 'QTZC', name: '其他支出', parentCode: 'ZJF', isLeaf: true },
  { code: 'JJF', name: '间接费', parentCode: null, isLeaf: false },
  { code: 'KYJX', name: '科研绩效', parentCode: 'JJF', isLeaf: true },
  { code: 'GLF', name: '管理费', parentCode: 'JJF', isLeaf: true },
];

/** 把字符串金额解析为 number(失败/空 → 0);仅用于显示求和提示。 */
function toDisplayNumber(s: string | undefined | null): number {
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** 数字小输入(数量/单价):仅过滤非数字字符,保留原始文本。 */
function NumCellInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      className={cn(
        'h-7 rounded-md border border-input bg-card px-2 text-right text-sm tabular-nums outline-none',
        'placeholder:text-left placeholder:text-mute',
        'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30',
        className,
      )}
      value={value}
      placeholder={placeholder}
      onChange={(e) => {
        const v = e.target.value.replace(/[^0-9.]/g, '');
        // 保留首个小数点。
        const dot = v.indexOf('.');
        onChange(dot >= 0 ? v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '') : v);
      }}
    />
  );
}

/** 通用确认对话框状态(替代 antd Popconfirm)。 */
interface ConfirmState {
  title: string;
  description?: string;
  action: () => void;
}

export default function InitialBudgetPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [draft, setDraft] = useState<InitialBudgetDraftView | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  // 表单状态。
  const [projectTotal, setProjectTotal] = useState<string>('');
  const [annualRows, setAnnualRows] = useState<AnnualRow[]>([]);
  const [subjectRows, setSubjectRows] = useState<SubjectRow[]>([]);
  // subjectBudgets 以 "subjectCode|year" → amount 的形式持有(由单位/数量/单价推导的展示金额)。
  const [subjectAmounts, setSubjectAmounts] = useState<Record<string, string>>({});
  // §enhance 年度分配明细:单位/数量/单价,键同 subjectAmounts。
  const [subjectDetails, setSubjectDetails] = useState<Record<string, SubjectBudgetDetail>>({});
  // subjectTotalBudgets 以 "subjectCode" → 总预算 amount 的形式持有(叶节点跨年度总额)。
  const [subjectTotalAmounts, setSubjectTotalAmounts] = useState<Record<string, string>>({});
  // 树表展开态(TanStack ExpandedState;true = 全部展开)。
  const [expanded, setExpanded] = useState<ExpandedState>(true);
  // 脏状态(编辑器交互优化:离开时拦截)。
  const [dirty, setDirty] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  // 已生效态复用台账数据(树形展示,与 ledger 页一致)。
  const [ledgerNodes, setLedgerNodes] = useState<LedgerNode[]>([]);
  const [ledgerYear, setLedgerYear] = useState<number>(() => new Date().getFullYear());
  // 行内删除/套用模板的确认对话框。
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  /** 编辑动作统一入口:标脏 + 执行。 */
  const markDirty = useCallback(() => setDirty(true), []);

  // 脏状态离开拦截:beforeunload 管浏览器关闭/刷新;
  // capture 阶段拦截站内 <a> 点击,管 SPA 客户端导航(项目 Tab/侧边栏等,绕过 beforeunload)。
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      // 仅拦站内页面跳转;外链、hash、tel/mailto 等放行。
      if (!href || !href.startsWith('/')) return;
      if (!window.confirm('有未保存的修改,确定要离开吗?离开后将丢失未保存内容。')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  /** 把 draft 回填到表单状态(DRAFT/REJECTED/WITHDRAWN 可再编辑)。 */
  const hydrateForm = useCallback((d: InitialBudgetDraftView) => {
    setProjectTotal(d.projectTotal);
    const rows = d.subjects.map((s) => ({
      key: genKey(),
      code: s.code,
      name: s.name,
      parentCode: s.parentCode,
      // isLeaf 不再持久化到行:提交时由 leafCodes 推导。
      description: s.description ?? undefined,
    }));
    setAnnualRows(d.annualBudgets.map((a) => ({ key: genKey(), year: a.year, amount: a.amount })));
    setSubjectRows(rows);
    // 回填时全部展开(沿用原 defaultExpandAllRows 首屏行为)。
    setExpanded(true);
    const amounts: Record<string, string> = {};
    const details: Record<string, SubjectBudgetDetail> = {};
    for (const sb of d.subjectBudgets) {
      const k = `${sb.subjectCode}|${sb.year}`;
      amounts[k] = sb.amount;
      // §enhance3:回填明细(单位/数量/单价);存量草稿可能为 null,缺省给空串占位。
      details[k] = {
        unit: sb.unit ?? '',
        quantity: sb.quantity ?? '',
        unitPrice: sb.unitPrice ?? '',
      };
    }
    setSubjectAmounts(amounts);
    setSubjectDetails(details);
    const totals: Record<string, string> = {};
    for (const st of d.subjectTotalBudgets ?? []) {
      totals[st.subjectCode] = st.amount;
    }
    setSubjectTotalAmounts(totals);
    setDirty(false); // 回填是服务端状态,不算未保存修改。
  }, []);

  /**
   * 新编制(无草稿)的默认起点:预设科目模板 + 一行当年年度预算(金额留空)。
   * 不标脏——这是默认状态而非用户修改;保存后才产生草稿。
   */
  const applyNewBudgetDefaults = useCallback(() => {
    const rows = DEFAULT_SUBJECT_TEMPLATE.map((t) => ({
      key: genKey(),
      code: t.code,
      name: t.name,
      parentCode: t.parentCode,
    }));
    setSubjectRows(rows);
    setAnnualRows([{ key: genKey(), year: new Date().getFullYear(), amount: '' }]);
    setExpanded(true);
  }, []);

  /** 加载项目头 + 编制草稿(仅一次)。 */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 项目头是强需求;草稿可能不存在(404 即无草稿)。
        const [proj, draftResult] = await Promise.all([
          apiFetch<ProjectDetail>(`/api/projects/${projectId}`),
          apiFetch<InitialBudgetDraftView | null>(
            `/api/projects/${projectId}/initial-budget`,
          ).catch((e: unknown) => {
            // GET 在无草稿时返回 404(见 getDraft 抛 HTTPError 404)→ 视为无草稿。
            if (e instanceof Error && 'status' in e && (e as { status: number }).status === 404) {
              return null;
            }
            throw e;
          }),
        ]);
        if (cancelled) return;
        setProject(proj);
        if (draftResult) {
          setDraft(draftResult);
          // 预填表单(无论状态,只读态展示也复用同一份数据)。
          hydrateForm(draftResult);
        } else {
          // 新编制(无草稿):默认套用预设科目模板 + 当年年度行。
          // 这是默认起点而非用户修改,不标脏。
          applyNewBudgetDefaults();
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : '加载编制信息失败';
          setFatal(msg);
          if (e instanceof Error) toast.error(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, hydrateForm, applyNewBudgetDefaults]);

  const status = draft?.status;

  // 可编辑态:无草稿、或草稿处于 DRAFT/REJECTED/WITHDRAWN。
  const editable = !draft || status === 'DRAFT' || status === 'REJECTED' || status === 'WITHDRAWN';

  // 已生效(APPROVED)态:拉取台账数据,以树形表(与 ledger 页一致)展示。
  const approvedYear = draft?.annualBudgets?.[0]?.year ?? new Date().getFullYear();
  useEffect(() => {
    if (status !== 'APPROVED') return;
    let cancelled = false;
    (async () => {
      try {
        const ledger = await apiFetch<{ nodes: LedgerNode[] }>(
          `/api/projects/${projectId}/ledger?year=${approvedYear}`,
        );
        if (!cancelled) {
          setLedgerYear(approvedYear);
          setLedgerNodes(ledger.nodes ?? []);
        }
      } catch (e) {
        // 台账拉取失败不阻塞页面(仍可回退到只读摘要)。
        if (!cancelled && e instanceof Error) {
          console.warn('加载台账失败:', e.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, status, approvedYear]);

  // ====== 年度预算编辑 ======
  const addAnnualRow = () => {
    markDirty();
    setAnnualRows((rs) => [...rs, { key: genKey(), year: new Date().getFullYear(), amount: '' }]);
  };
  const removeAnnualRow = (key: string) => {
    markDirty();
    setAnnualRows((rs) => rs.filter((r) => r.key !== key));
  };
  const updateAnnualRow = (key: string, patch: Partial<AnnualRow>) => {
    markDirty();
    setAnnualRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  // ====== 科目编辑(树形) ======
  /** 新增根科目:code 用 UUIDv7 自动生成,父为空。 */
  const addRootSubject = () => {
    markDirty();
    setSubjectRows((rs) => [...rs, { key: genKey(), code: uuidv7(), name: '', parentCode: null }]);
  };
  /** 在指定行下新增子科目:code 用 UUIDv7,parentCode 指向父 code;同时确保父行展开。 */
  const addChildSubject = (parentKey: string) => {
    markDirty();
    setSubjectRows((rs) => {
      const parent = rs.find((r) => r.key === parentKey);
      if (!parent) return rs;
      const childKey = genKey();
      // 父行展开(TanStack ExpandedState;true 已全展开则无需变)。
      if (expanded !== true) {
        setExpanded((prev) => (prev === true ? prev : { ...prev, [parentKey]: true }));
      }
      return [...rs, { key: childKey, code: uuidv7(), name: '', parentCode: parent.code }];
    });
  };
  /** 删除科目:仅允许删除没有子节点的行(由调用方禁用按钮,此处再防御一次)。 */
  const removeSubjectRow = (key: string) => {
    markDirty();
    setSubjectRows((rs) => {
      const target = rs.find((r) => r.key === key);
      if (!target) return rs;
      const hasChildren = rs.some((r) => r.parentCode === target.code);
      if (hasChildren) return rs; // 有下级 → 不删(防御)。
      return rs.filter((r) => r.key !== key);
    });
  };
  const updateSubjectRow = (key: string, patch: Partial<SubjectRow>) => {
    markDirty();
    setSubjectRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  /** 套用预设科目模板:替换当前科目树(用户可继续增删改)。 */
  const applyDefaultTemplate = () => {
    markDirty();
    const rows = DEFAULT_SUBJECT_TEMPLATE.map((t) => ({
      key: genKey(),
      code: t.code,
      name: t.name,
      parentCode: t.parentCode,
    }));
    setSubjectRows(rows);
    setExpanded(true);
    toast.success(`已套用预设模板(${DEFAULT_SUBJECT_TEMPLATE.length} 个科目),可在其上继续编辑`);
  };

  /** 清空科目树(从零自定义的出口,带确认)。 */
  const clearSubjects = () => {
    markDirty();
    setSubjectRows([]);
  };

  const declaredYears = useMemo(() => annualRows.map((r) => r.year), [annualRows]);

  /**
   * 叶节点集合(COMPUTED):一个 code 是叶 ⟺ 没有任何行把它作为 parentCode。
   * 这是判定"金额单元格是否可编辑"的唯一真相源(取代了原 isLeaf Switch)。
   */
  const leafCodes = useMemo(() => {
    const parentCodes = new Set<string>();
    for (const r of subjectRows) {
      if (r.parentCode) parentCodes.add(r.parentCode);
    }
    const leaves = new Set<string>();
    for (const r of subjectRows) {
      if (r.code && !parentCodes.has(r.code)) leaves.add(r.code);
    }
    return leaves;
  }, [subjectRows]);

  /** code → 是否有子节点(用于禁用"删除"按钮)。 */
  const hasChildrenByCode = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const r of subjectRows) {
      if (r.parentCode) m.set(r.parentCode, true);
    }
    return m;
  }, [subjectRows]);

  const isLeafRow = useCallback((row: SubjectRow) => leafCodes.has(row.code), [leafCodes]);

  /**
   * 把扁平 subjectRows 组装成树形数据。
   * 根 = parentCode 为空;子按 subjectRows 的原始顺序追加,不按 code 重排。
   */
  const subjectTree = useMemo<SubjectTreeNode[]>(() => {
    const byCode = new Map<string, SubjectTreeNode>();
    subjectRows.forEach((r) => byCode.set(r.code, { ...r }));
    const roots: SubjectTreeNode[] = [];
    subjectRows.forEach((r) => {
      const node = byCode.get(r.code)!;
      if (node.parentCode && byCode.has(node.parentCode)) {
        const parent = byCode.get(node.parentCode)!;
        parent.children = parent.children ?? [];
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    });
    return roots;
  }, [subjectRows]);

  /**
   * §enhance2 父节点自动汇总:非叶行展示其所有叶后代之和(只读、计算得出)。
   */
  const rollupByCode = useMemo(() => {
    const result = new Map<string, { total: number; byYear: Map<number, number> }>();
    const collectLeaves = (node: SubjectTreeNode): SubjectTreeNode[] => {
      if (!node.children || node.children.length === 0) return [node];
      const acc: SubjectTreeNode[] = [];
      for (const c of node.children) acc.push(...collectLeaves(c));
      return acc;
    };
    const walk = (nodes: SubjectTreeNode[]) => {
      for (const n of nodes) {
        const isLeaf = leafCodes.has(n.code);
        if (!isLeaf) {
          const leaves = collectLeaves(n).filter((l) => leafCodes.has(l.code));
          const leafCodeSet = new Set(leaves.map((l) => l.code));
          let total = 0;
          for (const l of leaves) {
            total += toDisplayNumber(subjectTotalAmounts[l.code]);
          }
          const byYear = new Map<number, number>();
          for (const [k, amt] of Object.entries(subjectAmounts)) {
            const [code, yearStr] = k.split('|');
            if (!leafCodeSet.has(code)) continue;
            const year = Number(yearStr);
            byYear.set(year, (byYear.get(year) ?? 0) + toDisplayNumber(amt));
          }
          result.set(n.code, { total, byYear });
        }
        if (n.children) walk(n.children);
      }
    };
    walk(subjectTree);
    return result;
  }, [subjectTree, leafCodes, subjectTotalAmounts, subjectAmounts]);

  /** §6.4 展示提示:年度合计对比项目总预算。 */
  const annualSum = useMemo(
    () => annualRows.reduce((acc, r) => acc + toDisplayNumber(r.amount), 0),
    [annualRows],
  );
  const projectTotalNum = toDisplayNumber(projectTotal);
  const annualOverTotal = projectTotal !== '' && annualSum > projectTotalNum + 1e-9;

  /** 各年度叶节点合计提示。 */
  const leafSumByYear = useMemo(() => {
    const m = new Map<number, number>();
    for (const [k, amt] of Object.entries(subjectAmounts)) {
      const [code, yearStr] = k.split('|');
      if (!leafCodes.has(code)) continue;
      const year = Number(yearStr);
      m.set(year, (m.get(year) ?? 0) + toDisplayNumber(amt));
    }
    return m;
  }, [leafCodes, subjectAmounts]);

  /** 组装提交 payload。isLeaf 由 leafCodes 在提交时推导。 */
  const buildPayload = (): InitialBudgetPayload => {
    // 仅保留叶子科目的预算,且仅对已声明年度。
    const yearSet = new Set(declaredYears);
    const subjectBudgets: InitialBudgetPayload['subjectBudgets'] = [];
    for (const [k, detail] of Object.entries(subjectDetails)) {
      const [code, yearStr] = k.split('|');
      const year = Number(yearStr);
      if (!leafCodes.has(code) || !yearSet.has(year)) continue;
      // §enhance3:三项明细须齐备才构成一条完整分配。
      if (!detail.unit.trim() || detail.quantity === '' || detail.unitPrice === '') continue;
      // 前端预算金额 = quantity × unitPrice(decimal.js);后端以同样公式重算为真相源。
      let amount = '0.00';
      try {
        amount = new D(detail.quantity).times(new D(detail.unitPrice)).toFixed(2);
      } catch {
        continue;
      }
      subjectBudgets.push({
        subjectCode: code,
        year,
        amount,
        unit: detail.unit.trim(),
        quantity: detail.quantity,
        unitPrice: detail.unitPrice,
      });
    }
    return {
      projectTotal: projectTotal === '' ? '0.00' : projectTotal,
      annualBudgets: annualRows
        .filter((r) => r.amount !== '' && r.amount !== undefined)
        .map((r) => ({ year: r.year, amount: r.amount })),
      subjects: subjectRows
        .filter((s) => s.code !== '' && s.name !== '')
        .map((s) => ({
          code: s.code,
          name: s.name,
          parentCode: s.parentCode,
          isLeaf: leafCodes.has(s.code),
          ...(s.description ? { description: s.description } : {}),
        })),
      subjectBudgets,
      // 叶节点总预算(跨年度);仅保留叶节点且有值的。
      subjectTotalBudgets: Object.entries(subjectTotalAmounts)
        .filter(([code, amt]) => leafCodes.has(code) && amt !== '' && amt !== undefined)
        .map(([subjectCode, amount]) => ({ subjectCode, amount })),
    };
  };

  /**
   * 提交流程(§6):
   * - 仅在无草稿(创建)场景下:POST create → 拿 appId → POST submit → 跳回项目详情。
   * - 若草稿已存在(DRAFT/REJECTED/WITHDRAWN):先 PATCH 保存(状态置回 DRAFT)再提交。
   */
  const handleSaveAndSubmit = async () => {
    setSubmitting(true);
    try {
      let appId: string;
      if (!draft) {
        const payload = buildPayload();
        const created = await apiFetch<{ appId: string }>(
          `/api/projects/${projectId}/initial-budget`,
          { method: 'POST', body: JSON.stringify(payload) },
        );
        appId = created.appId;
      } else {
        appId = draft.id;
        const payload = buildPayload();
        await apiFetch<{ appId: string }>(`/api/projects/${projectId}/initial-budget/${appId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      }
      await apiFetch<{ appId: string; status: ApprovalStatus }>(
        `/api/projects/${projectId}/initial-budget/${appId}/submit`,
        { method: 'POST' },
      );
      toast.success('已提交,等待审批');
      setDirty(false);
      router.push(`/projects/${projectId}`);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  /** 仅保存草稿(无草稿场景下先创建,不提交)。 */
  const handleSaveDraft = async () => {
    setSubmitting(true);
    try {
      const payload = buildPayload();
      if (draft) {
        await apiFetch<{ appId: string }>(`/api/projects/${projectId}/initial-budget/${draft.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch<{ appId: string }>(`/api/projects/${projectId}/initial-budget`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      toast.success('草稿已保存');
      setDirty(false);
      // 刷新本页,进入"已有草稿(DRAFT)"的可再编辑态。
      const fresh = await apiFetch<InitialBudgetDraftView>(
        `/api/projects/${projectId}/initial-budget`,
      );
      setDraft(fresh);
      hydrateForm(fresh);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ====== 科目树表列(TanStack ColumnDef) ======
  const subjectColumns = useMemo<ColumnDef<SubjectTreeNode>[]>(() => {
    /** §enhance3 单元格明细变更:重算推导金额并同步两个 map。 */
    const applyDetailChange = (
      key: string,
      current: SubjectBudgetDetail,
      patch: Partial<SubjectBudgetDetail>,
    ) => {
      markDirty();
      const nextDetail: SubjectBudgetDetail = { ...current, ...patch };
      // 推导金额:quantity × unitPrice(三项齐备时)。
      let amount = '';
      if (nextDetail.quantity !== '' && nextDetail.unitPrice !== '') {
        try {
          amount = new D(nextDetail.quantity).times(new D(nextDetail.unitPrice)).toFixed(2);
        } catch {
          amount = '';
        }
      }
      setSubjectDetails((map) => {
        const next = { ...map };
        if (
          nextDetail.unit.trim() === '' &&
          nextDetail.quantity === '' &&
          nextDetail.unitPrice === ''
        ) {
          delete next[key];
        } else {
          next[key] = nextDetail;
        }
        return next;
      });
      setSubjectAmounts((map) => {
        const next = { ...map };
        if (amount === '') {
          delete next[key];
        } else {
          next[key] = amount;
        }
        return next;
      });
    };

    const dynamicYearCols: ColumnDef<SubjectTreeNode>[] = declaredYears.map((y) => ({
      id: `year-${y}`,
      header: () => <span className="tabular-nums">{y}</span>,
      size: 340,
      cell: ({ row }) => {
        const node = row.original;
        const key = `${node.code}|${y}`;
        if (!editable) {
          const a = subjectAmounts[key];
          return a ? (
            <span className="tabular-nums">{a}</span>
          ) : (
            <span className="text-mute">—</span>
          );
        }
        // §enhance2 非叶行:显示叶后代汇总(只读、计算)。
        if (!isLeafRow(node)) {
          const rolled = rollupByCode.get(node.code)?.byYear.get(y);
          if (rolled === undefined) return <span className="text-mute">—</span>;
          return <span className="text-muted-foreground tabular-nums">{rolled.toFixed(2)}</span>;
        }
        // §enhance3 叶行:单位 × 数量 × 单价 → 金额(只读)。
        const detail = subjectDetails[key] ?? { unit: '', quantity: '', unitPrice: '' };
        const amt = subjectAmounts[key] ?? '';
        return (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <Input
              value={detail.unit}
              onChange={(e) => applyDetailChange(key, detail, { unit: e.target.value })}
              placeholder="单位"
              className="h-7 w-16"
            />
            <span className="text-mute">×</span>
            <NumCellInput
              value={detail.quantity}
              onChange={(v) => applyDetailChange(key, detail, { quantity: v })}
              placeholder="数量"
              className="w-20"
            />
            <span className="text-mute">×</span>
            <NumCellInput
              value={detail.unitPrice}
              onChange={(v) => applyDetailChange(key, detail, { unitPrice: v })}
              placeholder="单价"
              className="w-24"
            />
            <span className="text-mute">=</span>
            <span
              className={cn(
                'inline-block min-w-20 text-right font-medium tabular-nums',
                !amt && 'text-mute',
              )}
            >
              {amt || '0.00'}
            </span>
          </div>
        );
      },
    }));

    const cols: ColumnDef<SubjectTreeNode>[] = [
      {
        id: 'name',
        accessorKey: 'name',
        header: () => '名称',
        size: 260,
        cell: ({ row }) => {
          const node = row.original;
          return (
            <span
              className="flex items-center gap-1"
              style={{ paddingLeft: `${row.depth * 20}px` }}
            >
              {row.getCanExpand() ? (
                <button
                  type="button"
                  aria-label={row.getIsExpanded() ? '收起' : '展开'}
                  onClick={row.getToggleExpandedHandler()}
                  className="shrink-0 rounded-sm text-mute transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <ChevronRight
                    className={cn(
                      'size-4 transition-transform',
                      row.getIsExpanded() && 'rotate-90',
                    )}
                  />
                </button>
              ) : (
                <span className="size-4 shrink-0" />
              )}
              {editable ? (
                <Input
                  value={node.name}
                  onChange={(e) => updateSubjectRow(node.key, { name: e.target.value })}
                  placeholder="如 设备购置费"
                  className="h-7 min-w-28 flex-1"
                />
              ) : (
                <span>{node.name}</span>
              )}
            </span>
          );
        },
      },
      {
        // 科目总预算(跨年度):叶节点可填;非叶节点显示叶后代汇总(只读)。
        id: 'subject-total',
        header: () => <span className="block text-right">总预算</span>,
        size: 160,
        cell: ({ row }) => {
          const node = row.original;
          if (!editable) {
            const t = subjectTotalAmounts[node.code];
            return t ? (
              <span className="block text-right tabular-nums">{t}</span>
            ) : (
              <span className="block text-right text-mute">—</span>
            );
          }
          if (!isLeafRow(node)) {
            const rolled = rollupByCode.get(node.code)?.total;
            if (rolled === undefined || rolled === 0) {
              return <span className="block text-right text-mute">—</span>;
            }
            return (
              <span className="block text-right text-muted-foreground tabular-nums">
                {rolled.toFixed(2)}
              </span>
            );
          }
          return (
            <AmountInput
              size="sm"
              value={subjectTotalAmounts[node.code] || undefined}
              onChange={(v) => {
                markDirty();
                setSubjectTotalAmounts((prev) => {
                  const next = { ...prev };
                  if (v === undefined || v === '') {
                    delete next[node.code];
                  } else {
                    next[node.code] = v;
                  }
                  return next;
                });
              }}
            />
          );
        },
      },
      ...dynamicYearCols,
    ];

    if (editable) {
      cols.push({
        id: 'op',
        header: () => '',
        size: 150,
        cell: ({ row }) => {
          const node = row.original;
          const hasChildren = !!hasChildrenByCode.get(node.code);
          return (
            <span className="flex items-center gap-1 whitespace-nowrap">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-xs"
                onClick={() => addChildSubject(node.key)}
              >
                <Plus className="size-3.5" />
                子节点
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-1.5 text-xs text-error-deep hover:bg-error-soft"
                disabled={hasChildren}
                title={hasChildren ? '请先删除下级科目' : undefined}
                onClick={() =>
                  setConfirm({
                    title: '删除该科目?',
                    action: () => removeSubjectRow(node.key),
                  })
                }
              >
                删除
              </Button>
            </span>
          );
        },
      });
    }

    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editable,
    declaredYears,
    subjectAmounts,
    subjectDetails,
    subjectTotalAmounts,
    rollupByCode,
    hasChildrenByCode,
    isLeafRow,
  ]);

  // useReactTable 与 React Compiler 记忆化假设不兼容(官方已知,功能正常),禁用该告警。
  // eslint-disable-next-line react-hooks/incompatible-library
  const subjectTable = useReactTable({
    data: subjectTree,
    columns: subjectColumns,
    state: { expanded },
    onExpandedChange: setExpanded,
    getSubRows: (row) => row.children,
    getRowId: (row) => row.key,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  // ====== 渲染 ======
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
        <AlertTitle>无法访问该项目</AlertTitle>
        <AlertDescription>{fatal ?? '项目可能不存在或您没有访问权限。'}</AlertDescription>
      </Alert>
    );
  }

  // 只读态:已生效。复用台账树形表(与 ledger 页一致);
  // 提供「修改预算」入口跳转预算调整流程。
  if (status === 'APPROVED') {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge variant="success">已生效</Badge>
          <Button onClick={() => router.push(`/projects/${projectId}/adjustments`)}>
            修改预算
          </Button>
        </div>
        <Alert variant="success">
          <AlertTitle>该预算已生效</AlertTitle>
          <AlertDescription>
            如需变更预算,请点击「修改预算」进入预算调整流程,初始预算编制不可再直接修改。
          </AlertDescription>
        </Alert>
        <h2 className="text-base font-semibold tracking-[-0.3px]">{ledgerYear} 年度预算执行台账</h2>
        {ledgerNodes.length > 0 ? (
          <BudgetTreeTable nodes={ledgerNodes} />
        ) : (
          <ReadOnlyView
            projectTotal={draft?.projectTotal ?? ''}
            annualBudgets={draft?.annualBudgets ?? []}
            subjects={draft?.subjects ?? []}
            subjectBudgets={draft?.subjectBudgets ?? []}
            subjectTotalBudgets={draft?.subjectTotalBudgets}
          />
        )}
      </div>
    );
  }

  // 只读态:待审批。
  if (status === 'PENDING') {
    return (
      <div className="space-y-4">
        <div>
          <Badge variant="warning">待审批</Badge>
        </div>
        <Alert variant="info">
          <AlertTitle>已提交,等待审批</AlertTitle>
          <AlertDescription>该编制单已提交,正在等待审批。审批通过后将自动生效。</AlertDescription>
        </Alert>
        <ReadOnlyView
          projectTotal={draft?.projectTotal ?? ''}
          annualBudgets={draft?.annualBudgets ?? []}
          subjects={draft?.subjects ?? []}
          subjectBudgets={draft?.subjectBudgets ?? []}
          subjectTotalBudgets={draft?.subjectTotalBudgets}
        />
      </div>
    );
  }

  // 编辑态:无草稿 或 DRAFT/REJECTED/WITHDRAWN。
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {status ? (
          <Badge variant={STATUS_BADGE[status]}>{STATUS_LABEL[status]}</Badge>
        ) : (
          <Badge variant="outline">未保存</Badge>
        )}
        {dirty ? <span className="text-xs text-warning-deep">有未保存的修改</span> : null}
      </div>

      {status === 'REJECTED' && (
        <Alert variant="error">
          <AlertDescription>该编制单已被驳回,请修改后重新提交。</AlertDescription>
        </Alert>
      )}
      {status === 'WITHDRAWN' && (
        <Alert variant="warning">
          <AlertDescription>该编制单已撤回,可继续编辑后重新提交。</AlertDescription>
        </Alert>
      )}

      {/* §6.4 提示:年度合计超过总预算(仅展示,后端是真相源)。 */}
      {annualOverTotal && (
        <Alert variant="error">
          <AlertDescription>
            年度预算合计({annualSum.toFixed(2)})超过项目总预算({projectTotalNum.toFixed(2)}
            ),提交时后端将校验失败。
          </AlertDescription>
        </Alert>
      )}

      {/* ====== 第一区:项目总预算 ====== */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold tracking-[-0.3px]">项目总预算</h2>
        <div className="flex items-center gap-2">
          <Label className="font-normal text-muted-foreground">总预算金额</Label>
          <AmountInput
            value={projectTotal || undefined}
            onChange={(v) => {
              markDirty();
              setProjectTotal(v ?? '');
            }}
            className="w-60"
            disabled={!editable}
            placeholder="0.00"
          />
        </div>
      </section>

      {/* ====== 第二区:年度预算 ====== */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold tracking-[-0.3px]">年度预算</h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground tabular-nums">
              年度合计:{annualSum.toFixed(2)}
              {projectTotal !== '' && (
                <>
                  {' / 总预算 '}
                  {projectTotalNum.toFixed(2)}
                  {annualOverTotal ? <span className="ml-1 text-error-deep">(超支)</span> : null}
                </>
              )}
            </span>
            {editable && (
              <Button variant="outline" size="sm" onClick={addAnnualRow}>
                <Plus />
                新增年度
              </Button>
            )}
          </div>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-44">年度</TableHead>
                <TableHead className="w-64">金额</TableHead>
                <TableHead className="w-36 text-right">叶节点合计</TableHead>
                {editable ? <TableHead className="w-16" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {annualRows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={editable ? 4 : 3}
                    className="h-24 text-center text-muted-foreground"
                  >
                    暂无年度预算,点击「新增年度」
                  </TableCell>
                </TableRow>
              ) : (
                annualRows.map((row) => {
                  const sum = leafSumByYear.get(row.year) ?? 0;
                  const annual = toDisplayNumber(row.amount);
                  const over = sum > annual + 1e-9;
                  return (
                    <TableRow key={row.key} className="hover:bg-transparent">
                      <TableCell>
                        {editable ? (
                          <Input
                            type="number"
                            min={1900}
                            max={9999}
                            value={row.year}
                            onChange={(e) =>
                              updateAnnualRow(row.key, { year: Number(e.target.value ?? 0) })
                            }
                            className="h-7 w-28 tabular-nums"
                          />
                        ) : (
                          <span className="tabular-nums">{row.year}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {editable ? (
                          <AmountInput
                            size="sm"
                            value={row.amount || undefined}
                            onChange={(v) => updateAnnualRow(row.key, { amount: v ?? '' })}
                            className="w-56"
                          />
                        ) : (
                          <span className="tabular-nums">{row.amount}</span>
                        )}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          over && 'font-medium text-error-deep',
                        )}
                      >
                        {sum.toFixed(2)}
                      </TableCell>
                      {editable ? (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 text-mute hover:text-error-deep"
                            aria-label="删除该年度"
                            onClick={() =>
                              setConfirm({
                                title: '删除该年度?',
                                action: () => removeAnnualRow(row.key),
                              })
                            }
                          >
                            <Trash2 />
                          </Button>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* ====== 第三区:科目树 + 叶节点预算(树形可编辑表,TanStack Table) ====== */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold tracking-[-0.3px]">科目树与叶节点预算</h2>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground tabular-nums">
              科目数:{subjectRows.length}
            </span>
            {editable && (
              <>
                <Button variant="outline" size="sm" onClick={addRootSubject}>
                  <Plus />
                  新增根科目
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setConfirm({
                      title: '套用预设模板',
                      description:
                        subjectRows.length > 0
                          ? '将替换当前已编辑的科目树,确认继续?'
                          : '将填入默认预算科目结构(直接费/间接费等),可继续修改。',
                      action: applyDefaultTemplate,
                    })
                  }
                >
                  套用预设模板
                </Button>
                {subjectRows.length > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-error-deep hover:bg-error-soft"
                    onClick={() =>
                      setConfirm({
                        title: '清空全部科目?',
                        description:
                          '将移除当前科目树(不影响已保存内容,下次保存后生效),可重新「套用预设模板」或从零新增。',
                        action: clearSubjects,
                      })
                    }
                  >
                    清空科目
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-l2">
          {subjectRows.length === 0 ? (
            <EmptyState title="暂无科目,点击「新增根科目」或「套用预设模板」" className="m-4" />
          ) : (
            <Table>
              <TableHeader>
                {subjectTable.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id} className="hover:bg-transparent">
                    {hg.headers.map((header) => (
                      <TableHead
                        key={header.id}
                        style={{ width: header.getSize() }}
                        className="whitespace-nowrap"
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {subjectTable.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} className="hover:bg-transparent">
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="py-1.5">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </section>

      {/* ====== 操作按钮 ====== */}
      <div className="flex gap-2">
        {!draft && (
          <Button variant="outline" onClick={handleSaveDraft} disabled={submitting}>
            保存草稿
          </Button>
        )}
        <Button onClick={handleSaveAndSubmit} disabled={submitting}>
          {submitting ? '提交中…' : draft ? '提交' : '保存并提交'}
        </Button>
        <Button variant="ghost" onClick={() => router.push(`/projects/${projectId}`)}>
          取消
        </Button>
      </div>

      {/* 通用确认对话框(替代 antd Popconfirm) */}
      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            {confirm?.description ? (
              <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                confirm?.action();
                setConfirm(null);
              }}
            >
              确认
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ============================================================
// 子组件:只读视图(PENDING / APPROVED)。
// ============================================================

interface ReadOnlyProps {
  projectTotal: string;
  annualBudgets: { year: number; amount: string }[];
  subjects: {
    id: string;
    code: string;
    name: string;
    parentCode: string | null;
    isLeaf: boolean;
    description: string | null;
  }[];
  subjectBudgets: { year: number; subjectCode: string; amount: string }[];
  subjectTotalBudgets?: { subjectCode: string; amount: string }[];
}

function ReadOnlyView({
  projectTotal,
  annualBudgets,
  subjects,
  subjectBudgets,
  subjectTotalBudgets,
}: ReadOnlyProps) {
  const years = annualBudgets.map((a) => a.year);
  const amountFor = (code: string, year: number): string => {
    const hit = subjectBudgets.find((sb) => sb.subjectCode === code && sb.year === year);
    return hit ? hit.amount : '';
  };
  const totalFor = (code: string): string => {
    const hit = subjectTotalBudgets?.find((st) => st.subjectCode === code);
    return hit ? hit.amount : '';
  };

  return (
    <div className="space-y-4">
      <p className="text-sm">
        <span className="text-muted-foreground">项目总预算:</span>
        <span className="ml-1 font-semibold tabular-nums">{projectTotal || '0.00'}</span>
      </p>

      <section className="space-y-2">
        <h2 className="text-base font-semibold tracking-[-0.3px]">年度预算</h2>
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-40">年度</TableHead>
                <TableHead className="text-right">金额</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {annualBudgets.map((a) => (
                <TableRow key={a.year}>
                  <TableCell className="tabular-nums">{a.year}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.amount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold tracking-[-0.3px]">科目树与叶节点预算</h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-28">编码</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="w-32">父科目</TableHead>
                <TableHead className="w-20">叶节点</TableHead>
                <TableHead className="w-32 text-right">总预算</TableHead>
                {years.map((y) => (
                  <TableHead key={y} className="w-32 text-right tabular-nums">
                    {y}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {subjects.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-[13px]">{s.code}</TableCell>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>{s.parentCode ?? <span className="text-mute">(根)</span>}</TableCell>
                  <TableCell>
                    {s.isLeaf ? (
                      <Badge variant="success">叶</Badge>
                    ) : (
                      <Badge variant="secondary">非叶</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s.isLeaf ? (
                      totalFor(s.code) || <span className="text-mute">—</span>
                    ) : (
                      <span className="text-mute">—</span>
                    )}
                  </TableCell>
                  {years.map((y) => (
                    <TableCell key={y} className="text-right tabular-nums">
                      {s.isLeaf ? (
                        amountFor(s.code, y) || <span className="text-mute">—</span>
                      ) : (
                        <span className="text-mute">非叶节点</span>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
