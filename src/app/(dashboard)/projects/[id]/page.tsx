'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Descriptions, Result, Skeleton, Space, Tag, Typography, message } from 'antd';
import dayjs from 'dayjs';

import { apiFetch } from '@/lib/api/client';

const { Title } = Typography;

interface ProjectDetail {
  id: string;
  code: string;
  name: string;
  level: string | null;
  startDate: string | null;
  endDate: string | null;
  ownerId: string;
  remark: string | null;
  createdAt: string;
}

/** 初始预算编制单状态(Task 3 之后才有真实数据;此处仅做状态展示)。 */
interface InitialBudgetState {
  id?: string;
  status?: string;
}

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  DRAFT: { text: '草稿中', color: 'default' },
  PENDING: { text: '待审批', color: 'processing' },
  APPROVED: { text: '已生效', color: 'success' },
  REJECTED: { text: '已驳回', color: 'error' },
  WITHDRAWN: { text: '已撤回', color: 'warning' },
};

const formatDate = (d: string | null) => (d ? dayjs(d).format('YYYY-MM-DD') : '—');

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [budget, setBudget] = useState<InitialBudgetState | null>(null);
  // 初始即为 true,避免 mount effect 内同步 setState(react-hooks/set-state-in-effect)。
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [p, b] = await Promise.allSettled([
          apiFetch<ProjectDetail>(`/api/projects/${projectId}`),
          apiFetch<InitialBudgetState | null>(`/api/projects/${projectId}/initial-budget`),
        ]);
        if (cancelled) return;
        if (p.status === 'fulfilled') {
          setProject(p.value);
        } else {
          // 403/404 等:详情拿不到就显示错误态。
          setNotFound(true);
          if (p.reason instanceof Error) message.error(p.reason.message);
        }
        if (b.status === 'fulfilled' && b.value) {
          setBudget(b.value);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) return <Skeleton active />;
  if (notFound || !project) {
    return (
      <Result
        status="warning"
        title="无法访问该项目"
        subTitle="项目可能不存在或您没有访问权限。"
        extra={
          <Button type="primary" onClick={() => router.push('/projects')}>
            返回项目列表
          </Button>
        }
      />
    );
  }

  const statusInfo = budget?.status ? STATUS_LABEL[budget.status] : undefined;
  const isEffective = budget?.status === 'APPROVED';

  return (
    <>
      <Title level={3} style={{ marginTop: 0 }}>
        {project.name}
      </Title>

      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => router.push('/projects')}>返回列表</Button>
        <Button type="primary" onClick={() => router.push(`/projects/${projectId}/initial-budget`)}>
          编制预算
        </Button>
        <Button onClick={() => router.push(`/projects/${projectId}/ledger`)}>预算执行台账</Button>
        <Button onClick={() => router.push(`/projects/${projectId}/imports`)}>Excel 导入</Button>
      </Space>

      <Descriptions bordered column={2} size="small">
        <Descriptions.Item label="项目编号">{project.code}</Descriptions.Item>
        <Descriptions.Item label="项目名称">{project.name}</Descriptions.Item>
        <Descriptions.Item label="级别">{project.level ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="起止时间">
          {formatDate(project.startDate)} ~ {formatDate(project.endDate)}
        </Descriptions.Item>
        <Descriptions.Item label="创建时间">
          {dayjs(project.createdAt).format('YYYY-MM-DD HH:mm')}
        </Descriptions.Item>
        <Descriptions.Item label="预算状态">
          {statusInfo ? <Tag color={statusInfo.color}>{statusInfo.text}</Tag> : '未编制'}
        </Descriptions.Item>
        <Descriptions.Item label="备注" span={2}>
          {project.remark ?? '—'}
        </Descriptions.Item>
      </Descriptions>

      {isEffective ? (
        <div style={{ marginTop: 24, padding: 16, background: '#f6ffed', borderRadius: 8 }}>
          <Typography.Text strong>初始预算已生效</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>
            可前往「预算执行台账」查看各科目当前预算与占用情况。
          </Typography.Paragraph>
        </div>
      ) : null}
    </>
  );
}
