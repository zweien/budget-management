'use client';

import { useMemo } from 'react';
import { Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { MoneyText } from '@/components/ui/MoneyText';

/** 与 T5 ledger.service 输出一致的扁平节点(§11.1 台账单元)。 */
export interface LedgerNode {
  subjectId: string;
  code: string;
  name: string;
  isLeaf: boolean;
  level: number;
  parentId: string | null;
  initial: string;
  adjustment: string;
  current: string;
  totalCurrent: string;
  paid: string;
  payable: string;
  totalOccupied: string;
  balance: string;
  executionRate: number | null;
}

interface TreeNode extends LedgerNode {
  key: string;
  children?: TreeNode[];
}

interface Props {
  nodes: LedgerNode[];
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

/** 右对齐纯文本金额单元格(无风险色)。 */
function rightMoney(value: string) {
  return <span style={{ float: 'right' }}>{plainMoney(value)}</span>;
}

/** 把扁平 nodes(parentId 链接)组装为 AntD Table 树形结构。 */
function buildTree(nodes: LedgerNode[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  nodes.forEach((n) => map.set(n.subjectId, { ...n, key: n.subjectId }));
  const roots: TreeNode[] = [];
  // 保持后端返回顺序(已按编制 sortOrder 排序),不在此重排。
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

/**
 * §11.1 预算执行台账树形表。
 * 列:科目 / 初始 / 调整 / 当前 / 已支出 / 应付未付 / 总占用 / 结余 / 执行率。
 * 金额列右对齐两位小数;结余负数走 MoneyText 风险色 + "超预算"。
 */
export function BudgetTreeTable({ nodes }: Props) {
  const treeData = useMemo(() => buildTree(nodes), [nodes]);

  const columns: ColumnsType<TreeNode> = [
    {
      title: '预算科目',
      dataIndex: 'name',
      key: 'subject',
      // 树形首列由 Table 的 rowExpandable + indent 自带缩进,无需额外样式。
      // 仅显示科目名称,不展示编码。
      render: (_, r) => <span>{r.name}</span>,
    },
    { title: '初始预算', dataIndex: 'initial', key: 'initial', render: rightMoney },
    { title: '预算调整', dataIndex: 'adjustment', key: 'adjustment', render: rightMoney },
    { title: '当前预算', dataIndex: 'current', key: 'current', render: rightMoney },
    // 科目总预算(跨年度,SubjectTotalBudget):反映总预算维度的调整。
    { title: '科目总预算', dataIndex: 'totalCurrent', key: 'totalCurrent', render: rightMoney },
    { title: '已支出', dataIndex: 'paid', key: 'paid', render: rightMoney },
    { title: '应付未付', dataIndex: 'payable', key: 'payable', render: rightMoney },
    { title: '总占用', dataIndex: 'totalOccupied', key: 'totalOccupied', render: rightMoney },
    {
      title: '结余',
      dataIndex: 'balance',
      key: 'balance',
      // 负结余 → MoneyText 风险色 + "超预算"(§12.2)。
      render: (_, r) => <MoneyText value={r.balance} riskOnNegative />,
    },
    {
      title: '执行率',
      dataIndex: 'executionRate',
      key: 'executionRate',
      render: (_, r) => <span style={{ float: 'right' }}>{formatRate(r.executionRate)}</span>,
    },
  ];

  return (
    <Table<TreeNode>
      rowKey="key"
      columns={columns}
      dataSource={treeData}
      pagination={false}
      expandable={{ defaultExpandAllRows: true }}
      // 启用树形数据:children 字段自动展开/缩进。
      // 默认 rowExpandable 对有 children 的行生效。
      style={{ width: '100%' }}
    />
  );
}
