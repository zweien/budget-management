'use client';

import { useMemo, useState } from 'react';
import { Button, Checkbox, Popover, Table } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
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
 * 列顺序:科目 / [总预算:原始/调整/当前] / [年度:原始/调整/当前] / 已支出 / 应付未付 /
 *        总占用 / 结余 / 执行率。金额列右对齐两位小数;结余负数走 MoneyText 风险色。
 * 顶部「列设置」可勾选控制各金额列的显示/隐藏(科目列固定显示)。
 */

/** 可控显示的金额列定义(key 须与 LedgerNode 字段一致)。 */
interface ColumnDef {
  key: string;
  label: string;
  group: '总预算' | '年度' | '执行';
}

const TOGGLE_COLUMNS: ColumnDef[] = [
  { key: 'totalInitial', label: '总预算·原始', group: '总预算' },
  { key: 'totalAdjustment', label: '总预算·调整', group: '总预算' },
  { key: 'totalCurrent', label: '总预算·当前', group: '总预算' },
  { key: 'initial', label: '年度·原始', group: '年度' },
  { key: 'adjustment', label: '年度·调整', group: '年度' },
  { key: 'current', label: '年度·当前', group: '年度' },
  { key: 'paid', label: '已支出', group: '执行' },
  { key: 'payable', label: '应付未付', group: '执行' },
  { key: 'totalOccupied', label: '总占用', group: '执行' },
  { key: 'balance', label: '结余', group: '执行' },
  { key: 'executionRate', label: '执行率', group: '执行' },
];

export function BudgetTreeTable({ nodes }: Props) {
  const treeData = useMemo(() => buildTree(nodes), [nodes]);

  // 列显示状态(默认全部显示)。科目列固定不参与隐藏。
  const [visible, setVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(TOGGLE_COLUMNS.map((c) => [c.key, true])),
  );

  // 金额列 render:右对齐纯文本(无风险色)。具名以满足 react/display-name。
  const moneyRender = (key: keyof TreeNode) =>
    function MoneyCell(_: unknown, r: TreeNode) {
      return <span>{plainMoney(String(r[key]))}</span>;
    };

  const allColumns: ColumnsType<TreeNode> = [
    {
      title: '预算科目',
      dataIndex: 'name',
      key: 'subject',
      width: 160,
      // 树形首列由 Table 的 rowExpandable + indent 自带缩进,无需额外样式。
      // 仅显示科目名称,不展示编码。
      render: (_, r) => <span>{r.name}</span>,
    },
    // 总预算维度(跨年度,SubjectTotalBudget)。
    {
      title: '总预算·原始',
      dataIndex: 'totalInitial',
      key: 'totalInitial',
      width: 120,
      align: 'right',
      render: moneyRender('totalInitial'),
    },
    {
      title: '总预算·调整',
      dataIndex: 'totalAdjustment',
      key: 'totalAdjustment',
      width: 120,
      align: 'right',
      render: moneyRender('totalAdjustment'),
    },
    {
      title: '总预算·当前',
      dataIndex: 'totalCurrent',
      key: 'totalCurrent',
      width: 120,
      align: 'right',
      render: moneyRender('totalCurrent'),
    },
    // 年度预算维度(SubjectBudget)。
    {
      title: '年度·原始',
      dataIndex: 'initial',
      key: 'initial',
      width: 110,
      align: 'right',
      render: moneyRender('initial'),
    },
    {
      title: '年度·调整',
      dataIndex: 'adjustment',
      key: 'adjustment',
      width: 110,
      align: 'right',
      render: moneyRender('adjustment'),
    },
    {
      title: '年度·当前',
      dataIndex: 'current',
      key: 'current',
      width: 110,
      align: 'right',
      render: moneyRender('current'),
    },
    // 执行情况。
    {
      title: '已支出',
      dataIndex: 'paid',
      key: 'paid',
      width: 110,
      align: 'right',
      render: moneyRender('paid'),
    },
    {
      title: '应付未付',
      dataIndex: 'payable',
      key: 'payable',
      width: 110,
      align: 'right',
      render: moneyRender('payable'),
    },
    {
      title: '总占用',
      dataIndex: 'totalOccupied',
      key: 'totalOccupied',
      width: 110,
      align: 'right',
      render: moneyRender('totalOccupied'),
    },
    {
      title: '结余',
      dataIndex: 'balance',
      key: 'balance',
      width: 110,
      align: 'right',
      // 负结余 → MoneyText 风险色 + "超预算"(§12.2)。
      render: (_, r) => <MoneyText value={r.balance} riskOnNegative />,
    },
    {
      title: '执行率',
      dataIndex: 'executionRate',
      key: 'executionRate',
      width: 90,
      align: 'right',
      render: (_, r) => <span>{formatRate(r.executionRate)}</span>,
    },
  ];

  const columns = useMemo(
    () => allColumns.filter((col) => col.key === 'subject' || visible[col.key as string]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, nodes],
  );

  // 列设置弹出层。
  const groups: ColumnDef['group'][] = ['总预算', '年度', '执行'];
  const columnSettings = (
    <div style={{ maxWidth: 220 }}>
      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 12, color: '#8c8c8c', marginBottom: 4 }}>
            {g}
          </div>
          {TOGGLE_COLUMNS.filter((c) => c.group === g).map((c) => (
            <div key={c.key}>
              <Checkbox
                checked={visible[c.key]}
                onChange={(e) => setVisible((prev) => ({ ...prev, [c.key]: e.target.checked }))}
              >
                {c.label}
              </Checkbox>
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Popover
          content={columnSettings}
          title="显示列设置"
          trigger="click"
          placement="bottomRight"
        >
          <Button size="small" icon={<SettingOutlined />}>
            列设置
          </Button>
        </Popover>
      </div>
      <Table<TreeNode>
        rowKey="key"
        columns={columns}
        dataSource={treeData}
        pagination={false}
        expandable={{ defaultExpandAllRows: true }}
        // 启用树形数据:children 字段自动展开/缩进。
        scroll={{ x: 'max-content' }}
        style={{ width: '100%' }}
      />
    </div>
  );
}
