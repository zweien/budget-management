'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Button,
  Descriptions,
  Form,
  InputNumber,
  Modal,
  Result,
  Skeleton,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
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

/** §8.7 跨年结转预警条目。 */
interface CarryoverWarning {
  originalRecordId: string;
  subjectCode: string;
  reason: string;
}

/** §8.7 carryOver 返回。 */
interface CarryOverResult {
  carriedCount: number;
  warnings: CarryoverWarning[];
}

/** 跨年结转表单值。 */
interface CarryoverFormValues {
  fromYear: number;
  toYear: number;
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
  // §8.7 跨年结转 Modal。
  const [carryoverOpen, setCarryoverOpen] = useState(false);
  const [carryoverSubmitting, setCarryoverSubmitting] = useState(false);
  const [carryoverResult, setCarryoverResult] = useState<CarryOverResult | null>(null);
  const [carryoverForm] = Form.useForm<CarryoverFormValues>();

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

  /** §8.7 跨年结转。 */
  const handleCarryover = async () => {
    let values: CarryoverFormValues;
    try {
      values = await carryoverForm.validateFields();
    } catch {
      return;
    }
    if (values.toYear <= values.fromYear) {
      message.error('目标年度必须大于源年度');
      return;
    }
    setCarryoverSubmitting(true);
    try {
      const result = await apiFetch<CarryOverResult>(`/api/projects/${projectId}/carryover`, {
        method: 'POST',
        body: JSON.stringify(values),
      });
      setCarryoverResult(result);
      message.success(`已结转 ${result.carriedCount} 条记录`);
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setCarryoverSubmitting(false);
    }
  };

  /** 关闭结转 Modal,清空表单与结果。 */
  const closeCarryover = () => {
    setCarryoverOpen(false);
    setCarryoverResult(null);
    carryoverForm.resetFields();
  };

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
        <Button
          onClick={() => {
            setCarryoverResult(null);
            carryoverForm.resetFields();
            setCarryoverOpen(true);
          }}
        >
          跨年结转
        </Button>
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

      <Modal
        title="跨年结转"
        open={carryoverOpen}
        onCancel={closeCarryover}
        footer={
          carryoverResult
            ? [
                <Button key="close" type="primary" onClick={closeCarryover}>
                  关闭
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={closeCarryover}>
                  取消
                </Button>,
                <Button
                  key="ok"
                  type="primary"
                  loading={carryoverSubmitting}
                  onClick={handleCarryover}
                >
                  执行结转
                </Button>,
              ]
        }
        destroyOnHidden
      >
        {carryoverResult ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Alert
              type="success"
              showIcon
              message={`已结转 ${carryoverResult.carriedCount} 条业务记录`}
            />
            {carryoverResult.warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="以下记录需人工确认(§8.7)"
                description={
                  <ul style={{ marginBottom: 0, paddingLeft: 18 }}>
                    {carryoverResult.warnings.map((w) => (
                      <li key={w.originalRecordId}>
                        {w.subjectCode}:{w.reason}
                      </li>
                    ))}
                  </ul>
                }
              />
            )}
          </Space>
        ) : (
          <>
            <Typography.Paragraph type="secondary">
              将源年度中尚未支出(非 PAID)的业务记录结转到目标年度,生成可追溯记录。
            </Typography.Paragraph>
            <Form<CarryoverFormValues>
              form={carryoverForm}
              layout="vertical"
              initialValues={{
                fromYear: new Date().getFullYear(),
                toYear: new Date().getFullYear() + 1,
              }}
            >
              <Form.Item
                name="fromYear"
                label="源年度"
                rules={[{ required: true, message: '请输入源年度' }]}
              >
                <InputNumber min={1900} max={9999} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="toYear"
                label="目标年度"
                rules={[{ required: true, message: '请输入目标年度' }]}
              >
                <InputNumber min={1900} max={9999} style={{ width: '100%' }} />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>
    </>
  );
}
