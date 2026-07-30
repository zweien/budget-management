'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Skeleton,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import Link from 'next/link';

import { apiFetch } from '@/lib/api/client';
import { MoneyText } from '@/components/ui/MoneyText';

const { Title, Text } = Typography;

interface CurrentUser {
  id: string;
  name: string;
  role: string;
}

interface ProjectRef {
  id: string;
  code: string;
  name: string;
}

// ---- cross-project(管理员聚合)----
interface CrossProjectRow {
  projectId: string;
  name: string;
  currentBudget: string;
  totalOccupied: string;
  paid: string;
  balance: string;
  executionRate: number | null;
}
interface CrossProjectResult {
  projects: CrossProjectRow[];
}

// ---- ledger(非管理员聚合 + 风险预警:逐项目查当年科目)----
interface LedgerNode {
  subjectId: string;
  code: string;
  name: string;
  isLeaf: boolean;
  current: string;
  totalOccupied: string;
  balance: string;
  executionRate: number | null;
}
interface LedgerResponse {
  year: number;
  nodes: LedgerNode[];
}

// ---- 待审批事项(admin)----
interface PendingResponse {
  initialBudgets: unknown[];
  adjustments: unknown[];
  subjectChanges: unknown[];
}

/** 渲染执行率为百分比。 */
function renderRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return '—';
  return `${(rate * 100).toFixed(2)}%`;
}

export default function DashboardPage() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<CurrentUser>('/api/me')
      .then((u) => {
        if (!cancelled) setCurrentUser(u);
      })
      .catch(() => {
        // me 失败通常意味着未登录,不阻塞布局;下方渲染降级提示。
      })
      .finally(() => {
        if (!cancelled) setLoadingUser(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadingUser) return <Skeleton active />;
  if (!currentUser) {
    return (
      <Alert
        type="warning"
        showIcon
        message="未登录"
        description="无法获取当前用户身份,请刷新页面或在右上角切换用户。"
      />
    );
  }

  const isAdmin = currentUser.role === 'BUDGET_ADMIN';

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Space direction="vertical" size={0}>
        <Title level={3} style={{ margin: 0 }}>
          工作台
        </Title>
        <Text type="secondary">
          欢迎回来,{currentUser.name}(§12.1 项目概览 / 预算指标 / 风险预警 / 待办)
        </Text>
      </Space>

      <ProjectOverview isAdmin={isAdmin} />
      <BudgetMetricCards isAdmin={isAdmin} />
      <RiskWarnings isAdmin={isAdmin} />
      {isAdmin ? <PendingApprovals /> : null}
    </Space>
  );
}

// ============================================================
// 1) 项目概览(§12.1)
// ============================================================
function ProjectOverview({ isAdmin }: { isAdmin: boolean }) {
  // 管理员:cross-project 一次取回项目数;非 admin:/api/projects 取可访问项目列表。
  const [rows, setRows] = useState<ProjectRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const promise = isAdmin
      ? apiFetch<CrossProjectResult>('/api/statistics/cross-project').then((r) =>
          r.projects.map((p) => ({ id: p.projectId, code: '', name: p.name })),
        )
      : apiFetch<ProjectRef[]>('/api/projects').then((list) => list ?? []);
    promise
      .then((list) => {
        if (!cancelled) {
          setRows(list);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载项目失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const count = rows.length;

  return (
    <Card size="small" title="项目概览" loading={loading}>
      {error ? (
        <Alert type="error" message={error} />
      ) : (
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Statistic title={isAdmin ? '全部项目数' : '可访问项目数'} value={count} />
          <Link href="/projects">
            <Button type="link" style={{ padding: 0 }}>
              进入项目管理 →
            </Button>
          </Link>
          {!isAdmin && rows.length > 0 ? (
            <Text type="secondary">
              {rows
                .slice(0, 5)
                .map((r) => r.name)
                .join('、')}
              {rows.length > 5 ? ` 等 ${rows.length} 个` : ''}
            </Text>
          ) : null}
        </Space>
      )}
    </Card>
  );
}

// ============================================================
// 2) 预算指标卡片(§12.1)
//    - admin:cross-project 聚合(一次请求)
//    - 非 admin:逐项目取 ledger(当年)汇总叶节点(项目数通常不多,可接受)
// ============================================================
interface Metrics {
  currentBudget: string;
  totalOccupied: string;
  executionRate: number | null;
  balance: string;
}

function BudgetMetricCards({ isAdmin }: { isAdmin: boolean }) {
  const year = new Date().getFullYear();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const compute = async (): Promise<Metrics> => {
      if (isAdmin) {
        // 管理员:cross-project 一次取回所有项目行,前端再聚合。
        const data = await apiFetch<CrossProjectResult>(
          `/api/statistics/cross-project?year=${year}`,
        );
        return aggregateCross(data.projects);
      }
      // 非 admin:取可访问项目 → 逐项目 ledger(当年)。
      const projects = await apiFetch<ProjectRef[]>('/api/projects');
      const ledgers = await Promise.all(
        (projects ?? []).map((p) =>
          apiFetch<LedgerResponse>(`/api/projects/${p.id}/ledger?year=${year}`).catch(() => null),
        ),
      );
      return aggregateLedgers(ledgers.filter((l): l is LedgerResponse => l !== null));
    };

    compute()
      .then((m) => {
        if (!cancelled) {
          setMetrics(m);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载预算指标失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, year]);

  if (loading) {
    return (
      <Row gutter={[16, 16]}>
        {[0, 1, 2, 3].map((i) => (
          <Col xs={12} md={6} key={i}>
            <Card size="small">
              <Spin />
            </Card>
          </Col>
        ))}
      </Row>
    );
  }
  if (error) {
    return <Alert type="error" message={`预算指标:${error}`} />;
  }
  if (!metrics) {
    return <Empty description="暂无预算数据" />;
  }

  return (
    <div>
      <Title level={5} style={{ marginTop: 0 }}>
        预算指标({year} 年)
      </Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="当前预算"
              formatter={() => <MoneyText value={metrics.currentBudget} riskOnNegative={false} />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="总占用"
              formatter={() => <MoneyText value={metrics.totalOccupied} riskOnNegative={false} />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="执行率" value={renderRate(metrics.executionRate)} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="总结余" formatter={() => <MoneyText value={metrics.balance} />} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}

/** 把 cross-project 各行金额求和(字符串 → 求和 → 字符串)。 */
function aggregateCross(rows: CrossProjectRow[]): Metrics {
  let budget = 0;
  let occupied = 0;
  for (const r of rows) {
    budget += Number.parseFloat(r.currentBudget ?? '0') || 0;
    occupied += Number.parseFloat(r.totalOccupied ?? '0') || 0;
  }
  const balance = budget - occupied;
  return {
    currentBudget: budget.toFixed(2),
    totalOccupied: occupied.toFixed(2),
    balance: balance.toFixed(2),
    executionRate: budget > 0 ? occupied / budget : null,
  };
}

/** 把若干 ledger 的叶节点金额求和(只取 isLeaf=true 的节点,避免与父节点重复)。 */
function aggregateLedgers(ledgers: LedgerResponse[]): Metrics {
  let budget = 0;
  let occupied = 0;
  for (const ledger of ledgers) {
    for (const n of ledger.nodes) {
      if (n.isLeaf) {
        budget += Number.parseFloat(n.current ?? '0') || 0;
        occupied += Number.parseFloat(n.totalOccupied ?? '0') || 0;
      }
    }
  }
  const balance = budget - occupied;
  return {
    currentBudget: budget.toFixed(2),
    totalOccupied: occupied.toFixed(2),
    balance: balance.toFixed(2),
    executionRate: budget > 0 ? occupied / budget : null,
  };
}

// ============================================================
// 3) 风险预警(§12.1):负结余(超预算)的科目
// ============================================================
interface RiskRow {
  key: string;
  projectId: string;
  projectName: string;
  subjectCode: string;
  subjectName: string;
  balance: string;
  executionRate: number | null;
}

function RiskWarnings({ isAdmin }: { isAdmin: boolean }) {
  const year = new Date().getFullYear();
  const [risks, setRisks] = useState<RiskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const compute = async (): Promise<RiskRow[]> => {
      // admin 与非 admin 均通过 /api/projects 取得其可见项目(admin 全部,非 admin 可访问)。
      const projects = await apiFetch<ProjectRef[]>('/api/projects');
      const items = await Promise.all(
        (projects ?? []).map((p) =>
          apiFetch<LedgerResponse>(`/api/projects/${p.id}/ledger?year=${year}`)
            .then((l) => ({ project: p, ledger: l }))
            .catch(() => null),
        ),
      );
      const out: RiskRow[] = [];
      for (const item of items) {
        if (!item) continue;
        for (const n of item.ledger.nodes) {
          const bal = Number.parseFloat(n.balance ?? '0');
          if (Number.isFinite(bal) && bal < 0) {
            out.push({
              key: `${item.project.id}-${n.subjectId}`,
              projectId: item.project.id,
              projectName: item.project.name,
              subjectCode: n.code,
              subjectName: n.name,
              balance: n.balance,
              executionRate: n.executionRate,
            });
          }
        }
      }
      // 按结余升序(最负在前)。
      out.sort((a, b) => Number.parseFloat(a.balance) - Number.parseFloat(b.balance));
      return out;
    };

    compute()
      .then((rows) => {
        if (!cancelled) {
          setRisks(rows);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载风险预警失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, year]);

  const columns: ColumnsType<RiskRow> = [
    {
      title: '项目',
      dataIndex: 'projectName',
      key: 'projectName',
      render: (name: string, r) => <Link href={`/projects/${r.projectId}`}>{name}</Link>,
    },
    { title: '科目编码', dataIndex: 'subjectCode', key: 'subjectCode', width: 130 },
    { title: '科目名称', dataIndex: 'subjectName', key: 'subjectName' },
    {
      title: '结余',
      dataIndex: 'balance',
      key: 'balance',
      align: 'right',
      width: 160,
      render: (v: string) => <MoneyText value={v} />,
    },
    {
      title: '执行率',
      dataIndex: 'executionRate',
      key: 'executionRate',
      align: 'right',
      width: 120,
      render: (rate: number | null) => renderRate(rate),
    },
  ];

  return (
    <Card
      size="small"
      title="风险预警"
      extra={<Tag color={risks.length ? 'red' : 'green'}>{risks.length} 项</Tag>}
    >
      {error ? (
        <Alert type="error" message={error} />
      ) : (
        <Table<RiskRow>
          rowKey="key"
          size="small"
          loading={loading}
          dataSource={risks}
          columns={columns}
          pagination={false}
          locale={{ emptyText: `暂无负结余(超预算)科目(${year} 年)` }}
        />
      )}
    </Card>
  );
}

// ============================================================
// 4) 待审批事项(§12.1, admin only)
// ============================================================
function PendingApprovals() {
  const [pending, setPending] = useState<PendingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PendingResponse>('/api/approvals/pending')
      .then((data) => {
        if (!cancelled) {
          setPending(data);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载待办失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => {
    const initial = pending?.initialBudgets.length ?? 0;
    const adjust = pending?.adjustments.length ?? 0;
    const subject = pending?.subjectChanges.length ?? 0;
    return { initial, adjust, subject, total: initial + adjust + subject };
  }, [pending]);

  return (
    <Card
      size="small"
      title="待审批事项"
      extra={
        <Link href="/approvals">
          <Button type="link" style={{ padding: 0 }}>
            进入审批中心 →
          </Button>
        </Link>
      }
    >
      {loading ? (
        <Spin />
      ) : error ? (
        <Alert type="error" message={error} />
      ) : counts.total === 0 ? (
        <Empty description="暂无待审批事项" />
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={12} md={8}>
            <Statistic title="初始预算编制" value={counts.initial} />
          </Col>
          <Col xs={12} md={8}>
            <Statistic title="预算调整" value={counts.adjust} />
          </Col>
          <Col xs={12} md={8}>
            <Statistic title="科目变更" value={counts.subject} />
          </Col>
        </Row>
      )}
    </Card>
  );
}
