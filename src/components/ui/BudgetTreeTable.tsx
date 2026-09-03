'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
  type VisibilityState,
} from '@tanstack/react-table';
import { ChevronRight, Settings2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { MoneyText } from '@/components/ui/MoneyText';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** 与 T5 ledger.service 输出一致的扁平节点(§11.1 台账单元)。 */
export interface LedgerNode {
  subjectId: string;
  code: string;
  name: string;
  isLeaf: boolean;
  level: number;
  parentId: string | null;
  totalInitial: string;
  totalAdjustment: string;
  totalCurrent: string;
  initial: string;
  adjustment: string;
  current: string;
  paid: string;
  payable: string;
  totalOccupied: string;
  balance: string;
  executionRate: number | null;
}

interface TreeNode extends LedgerNode {
  children?: TreeNode[];
}

interface Props {
  nodes: LedgerNode[];
  /**
   * 科目名链接构造(可选):返回 href 则该科目名渲染为链接(DESIGN.md link 蓝),
   * 返回 undefined 则纯文本。台账页用它把叶科目链到业务记录筛选视图。
   */
  subjectHref?: (node: LedgerNode) => string | undefined;
  /**
   * §主要汇总行(可选):表格底部「合计(一级科目汇总)」行——
   * 各金额列 = 一级科目(parentId 为空)之和;执行率 = Σ 总占用 ÷ Σ 年度当前预算。
   * 隐藏列不出单元格;折叠/展开不影响结果。
   */
  showLevel1Total?: boolean;
}

/** 金额 → 千分位两位小数字符串(仅展示,不做风险色)。 */
function plainMoney(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** 执行率:number→百分比,null→"—"(避免除零场景渲染 NaN)。 */
function formatRate(rate: number | null): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(2)}%`;
}

/** 把扁平 nodes(parentId 链接)组装为树形结构(保持后端 sortOrder 顺序)。 */
function buildTree(nodes: LedgerNode[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  nodes.forEach((n) => map.set(n.subjectId, { ...n }));
  const roots: TreeNode[] = [];
  map.forEach((node) => {
    if (node.parentId && map.has(node.parentId)) {
      const parent = map.get(node.parentId)!;
      parent.children = parent.children ?? [];
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

/** 可控显示的金额列定义(id 须与 LedgerNode 字段一致)。 */
const TOGGLE_COLUMNS: { id: string; label: string; group: '总预算' | '年度' | '执行' }[] = [
  { id: 'totalInitial', label: '总预算·原始', group: '总预算' },
  { id: 'totalAdjustment', label: '总预算·调整', group: '总预算' },
  { id: 'totalCurrent', label: '总预算·当前', group: '总预算' },
  { id: 'initial', label: '年度·原始', group: '年度' },
  { id: 'adjustment', label: '年度·调整', group: '年度' },
  { id: 'current', label: '年度·当前', group: '年度' },
  { id: 'paid', label: '已支出', group: '执行' },
  { id: 'payable', label: '应付未付', group: '执行' },
  { id: 'totalOccupied', label: '总占用', group: '执行' },
  { id: 'balance', label: '结余', group: '执行' },
  { id: 'executionRate', label: '执行率', group: '执行' },
];

/** 参与列合计的金额字段(执行率不直接求和,按加权计算)。 */
const MONEY_COLUMN_IDS = [
  'totalInitial',
  'totalAdjustment',
  'totalCurrent',
  'initial',
  'adjustment',
  'current',
  'paid',
  'payable',
  'totalOccupied',
  'balance',
] as const;

/**
 * §11.1 预算执行台账树形表(TanStack Table 重写)。
 * 列顺序:科目 / [总预算:原始/调整/当前] / [年度:原始/调整/当前] / 已支出 / 应付未付 /
 *        总占用 / 结余 / 执行率。金额列右对齐两位小数;结余负数走 MoneyText 风险色。
 * 顶部「列设置」控制各金额列显隐(科目列固定)。
 */
export function BudgetTreeTable({ nodes, subjectHref, showLevel1Total }: Props) {
  const treeData = useMemo(() => buildTree(nodes), [nodes]);

  /**
   * §主要汇总行:一级科目(parentId 为空)各列之和 = 全体叶科目之和。
   * 执行率按加权计算(Σ 总占用 ÷ Σ 年度当前预算),与行级口径一致(current=0 → null)。
   */
  const level1Total = useMemo(() => {
    const num = (v: string) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const sums = new Map<string, number>(MONEY_COLUMN_IDS.map((id) => [id, 0]));
    let occupied = 0;
    let current = 0;
    for (const n of nodes) {
      if (n.parentId !== null) continue;
      for (const id of MONEY_COLUMN_IDS) {
        sums.set(id, (sums.get(id) ?? 0) + num(String(n[id])));
      }
      occupied += num(n.totalOccupied);
      current += num(n.current);
    }
    return { sums, rate: current > 0 ? occupied / current : null };
  }, [nodes]);

  // 列显隐(TanStack columnVisibility);科目列固定不参与。
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  // 默认全部展开(对齐原 defaultExpandAllRows)。
  const [expanded, setExpanded] = useState<ExpandedState>(true);

  const columns = useMemo<ColumnDef<TreeNode>[]>(() => {
    // 合计行 footer(可选):金额列 = 一级科目之和。
    // 结余列(codex P2)与数据行同款走 MoneyText 风险色——合计为负 = 项目整体超预算,
    // 合计行不能吞掉这个信号。footer 须为 string | 函数(ColumnDefTemplate),
    // 内联箭头直接写在列定义里(工厂返回匿名组件会触发 display-name 规则)。
    const moneySum = (id: (typeof MONEY_COLUMN_IDS)[number]) =>
      String(level1Total.sums.get(id) ?? 0);
    const moneyCol = (
      id: keyof TreeNode & string,
      label: string,
      sumId?: (typeof MONEY_COLUMN_IDS)[number],
    ): ColumnDef<TreeNode> => ({
      id,
      accessorKey: id,
      header: () => <span className="block text-right">{label}</span>,
      footer:
        showLevel1Total && sumId
          ? () => (
              <span className="block text-right tabular-nums">{plainMoney(moneySum(sumId))}</span>
            )
          : undefined,
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {plainMoney(String(row.original[id]))}
        </span>
      ),
    });

    return [
      {
        id: 'subject',
        accessorKey: 'name',
        header: () => '预算科目',
        footer: showLevel1Total ? '合计(一级科目汇总)' : undefined,
        cell: ({ row }) => (
          <span
            className="flex items-center gap-1 whitespace-nowrap"
            style={{ paddingLeft: `${row.depth * 20}px` }}
          >
            {row.getCanExpand() ? (
              <button
                type="button"
                aria-label={row.getIsExpanded() ? '收起' : '展开'}
                onClick={row.getToggleExpandedHandler()}
                className="rounded-sm text-mute transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <ChevronRight
                  className={cn('size-4 transition-transform', row.getIsExpanded() && 'rotate-90')}
                />
              </button>
            ) : (
              <span className="size-4" />
            )}
            {/* 仅显示科目名称,不展示编码(对齐原实现);有 href 时渲染为链接。 */}
            {(() => {
              const href = subjectHref?.(row.original);
              if (href) {
                return (
                  <Link
                    href={href}
                    className="text-link underline-offset-4 transition-colors outline-none hover:text-link-deep hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {row.original.name}
                  </Link>
                );
              }
              return (
                <span className={cn(row.original.isLeaf ? undefined : 'font-medium')}>
                  {row.original.name}
                </span>
              );
            })()}
          </span>
        ),
      },
      moneyCol('totalInitial', '总预算·原始', 'totalInitial'),
      moneyCol('totalAdjustment', '总预算·调整', 'totalAdjustment'),
      moneyCol('totalCurrent', '总预算·当前', 'totalCurrent'),
      moneyCol('initial', '年度·原始', 'initial'),
      moneyCol('adjustment', '年度·调整', 'adjustment'),
      moneyCol('current', '年度·当前', 'current'),
      moneyCol('paid', '已支出', 'paid'),
      moneyCol('payable', '应付未付', 'payable'),
      moneyCol('totalOccupied', '总占用', 'totalOccupied'),
      {
        id: 'balance',
        accessorKey: 'balance',
        header: () => <span className="block text-right">结余</span>,
        footer: showLevel1Total
          ? () => (
              <span className="block text-right">
                <MoneyText value={moneySum('balance')} riskOnNegative />
              </span>
            )
          : undefined,
        // 负结余 → MoneyText 风险色 + "超预算"(§12.2)。
        cell: ({ row }) => <MoneyText value={row.original.balance} riskOnNegative />,
      },
      {
        id: 'executionRate',
        accessorKey: 'executionRate',
        header: () => <span className="block text-right">执行率</span>,
        footer: showLevel1Total
          ? () => (
              <span className="block text-right tabular-nums">{formatRate(level1Total.rate)}</span>
            )
          : undefined,
        cell: ({ row }) => (
          <span className="block text-right tabular-nums">
            {formatRate(row.original.executionRate)}
          </span>
        ),
      },
    ];
  }, [subjectHref, showLevel1Total, level1Total]);

  // useReactTable 与 React Compiler 记忆化假设不兼容(官方已知,功能正常),禁用该告警。
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: treeData,
    columns,
    state: { expanded, columnVisibility },
    onExpandedChange: setExpanded,
    onColumnVisibilityChange: setColumnVisibility,
    getSubRows: (row) => row.children,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  const groups: ('总预算' | '年度' | '执行')[] = ['总预算', '年度', '执行'];

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <Settings2 />
              列设置
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56">
            <p className="caption-mono mb-2">显示列设置</p>
            {groups.map((g) => (
              <div key={g} className="mb-2 last:mb-0">
                <p className="mb-1 text-xs font-medium text-muted-foreground">{g}</p>
                {TOGGLE_COLUMNS.filter((c) => c.group === g).map((c) => {
                  const column = table.getColumn(c.id);
                  if (!column) return null;
                  return (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-accent"
                    >
                      <Checkbox
                        checked={column.getIsVisible()}
                        onCheckedChange={(checked) => column.toggleVisibility(checked === true)}
                      />
                      {c.label}
                    </label>
                  );
                })}
              </div>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((header) => (
                  <TableHead key={header.id} className="whitespace-nowrap">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {/* 合计行用普通 tr 渲染在首行:浏览会把 <tfoot> 固定渲染在表格底部,
                与「合计在第一行」的需求冲突(codex 实测),故不用 tfoot。 */}
            {showLevel1Total
              ? table.getFooterGroups().map((fg) => (
                  <TableRow
                    key={fg.id}
                    className="border-b border-border bg-muted/40 font-medium hover:bg-muted/40"
                  >
                    {fg.headers
                      .filter((h) => h.column.getIsVisible())
                      .map((h) => (
                        <TableCell key={h.id} className="whitespace-nowrap py-2">
                          {h.isPlaceholder
                            ? null
                            : flexRender(h.column.columnDef.footer, h.getContext())}
                        </TableCell>
                      ))}
                  </TableRow>
                ))
              : null}
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className="py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
