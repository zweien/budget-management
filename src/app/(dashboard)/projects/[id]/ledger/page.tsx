'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Button, Result, Select, Skeleton, Space, Typography, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';

import { apiFetch, downloadFile } from '@/lib/api/client';
import { BudgetTreeTable, type LedgerNode } from '@/components/ui/BudgetTreeTable';

const { Title, Text } = Typography;

interface ProjectLedger {
  year: number;
  nodes: LedgerNode[];
}

interface ProjectDetail {
  id: string;
  code: string;
  name: string;
}

/** 生成最近 5 年的年度选项(含当前年,按降序)。 */
function yearOptions(): number[] {
  const now = new Date().getFullYear();
  return [now, now - 1, now - 2, now - 3, now - 4];
}

export default function ProjectLedgerPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [year, setYear] = useState<number>(() => new Date().getFullYear());
  const [ledger, setLedger] = useState<ProjectLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // 拉取项目标题(仅一次)。
  useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectDetail>(`/api/projects/${projectId}`)
      .then((p) => {
        if (!cancelled) setProject(p);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) message.error(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 拉取台账数据(随年度变化重拉)。
  // loading/error 在年度切换的事件处理器里重置(事件驱动,非 effect 同步 setState);
  // 此处仅负责发请求并异步落结果。
  useEffect(() => {
    let cancelled = false;
    apiFetch<ProjectLedger>(`/api/projects/${projectId}/ledger?year=${year}`)
      .then((l) => {
        if (!cancelled) setLedger(l);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : '加载台账失败';
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, year]);

  /** 年度切换:同步重置在途状态后由上面的 effect 重拉。 */
  const handleYearChange = (next: number) => {
    setLoading(true);
    setError(null);
    setYear(next);
  };

  /** 导出当前年度台账为 xlsx(§10.5)。 */
  const handleExport = async () => {
    setExporting(true);
    try {
      await downloadFile(
        `/api/projects/${projectId}/export/ledger?year=${year}`,
        `ledger-${year}.xlsx`,
      );
      message.success('已开始下载台账');
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <Title level={3} style={{ marginTop: 0 }}>
        预算执行台账{project ? ` — ${project.name}` : ''}
      </Title>

      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => router.push(`/projects/${projectId}`)}>返回项目详情</Button>
        <Text type="secondary">年度:</Text>
        <Select<number>
          value={year}
          onChange={handleYearChange}
          style={{ width: 120 }}
          options={yearOptions().map((y) => ({ label: `${y} 年`, value: y }))}
        />
        <Button icon={<DownloadOutlined />} loading={exporting} onClick={handleExport}>
          导出台账
        </Button>
      </Space>

      {loading ? (
        <Skeleton active />
      ) : error ? (
        <Result
          status="warning"
          title="加载台账失败"
          subTitle={error}
          extra={
            <Button type="primary" onClick={() => router.push(`/projects/${projectId}`)}>
              返回项目详情
            </Button>
          }
        />
      ) : ledger && ledger.nodes.length > 0 ? (
        <BudgetTreeTable nodes={ledger.nodes} />
      ) : (
        <Alert
          type="info"
          showIcon
          message={`${year} 年度暂无预算执行数据`}
          description="可能是尚未编制或审批通过该年度的初始预算,或本年度还没有业务记录。"
        />
      )}
    </>
  );
}
