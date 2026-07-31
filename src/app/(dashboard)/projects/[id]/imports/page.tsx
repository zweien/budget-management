'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Result,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { InboxOutlined } from '@ant-design/icons';
import type { UploadRequestOption } from 'rc-upload/lib/interface';

import { apiFetch, bootstrapMockUser } from '@/lib/api/client';
import { MoneyText } from '@/components/ui/MoneyText';

const { Title, Text, Paragraph } = Typography;
const { Dragger } = Upload;

/** §10 预览页一行(对应 GET /imports/:batchId 返回的三分组项)。 */
interface PreviewRow {
  rowId: string;
  rowNo: number;
  parsedData: {
    projectCode: string | null;
    budgetYear: string | null;
    subjectCode: string | null;
    subjectName: string | null;
    amount: string | null;
    businessDate: string | null;
    handler: string | null;
    summary: string | null;
    businessStatus: string | null;
    remark: string | null;
  };
  validationStatus: 'valid' | 'error';
  errors: { field: string; message: string }[];
  duplicateFlag: boolean;
  forcedImport: boolean;
  normalizedAmount: string | null;
  normalizedStatus: string | null;
}

interface BatchPreview {
  batchId: string;
  projectId: string;
  fileName: string;
  templateVersion: string;
  status: string;
  createdAt: string;
  confirmedAt: string | null;
  valid: PreviewRow[];
  errors: PreviewRow[];
  duplicates: PreviewRow[];
}

/** 上传文件(走原生 fetch + mock header,不用 apiFetch 的 JSON Content-Type)。 */
async function uploadExcel(projectId: string, file: File): Promise<string> {
  const mockUserId = await bootstrapMockUser();
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/projects/${projectId}/imports`, {
    method: 'POST',
    headers: mockUserId ? { 'x-mock-user-id': mockUserId } : {},
    body: form,
  });
  const isJson = (res.headers.get('Content-Type') ?? '').includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `上传失败 (${res.status})`;
    throw new Error(msg);
  }
  return (body as { batchId: string }).batchId;
}

/** 下载模板(走原生 fetch + mock header,以触发文件下载)。 */
async function downloadTemplate(): Promise<void> {
  const mockUserId = await bootstrapMockUser();
  const res = await fetch('/api/excel-template', {
    headers: mockUserId ? { 'x-mock-user-id': mockUserId } : {},
  });
  if (!res.ok) {
    throw new Error(`下载模板失败 (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'business-records-template.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function PreviewTable({
  rows,
  selectable,
  selected,
  onToggle,
  emptyText,
}: {
  rows: PreviewRow[];
  selectable: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={emptyText}
        style={{ padding: '16px 0' }}
      />
    );
  }
  const columns: ColumnsType<PreviewRow> = [
    ...(selectable
      ? [
          {
            title: '',
            key: 'select',
            width: 40,
            render: (_: unknown, row: PreviewRow) => (
              <Checkbox checked={selected.has(row.rowId)} onChange={() => onToggle(row.rowId)} />
            ),
          },
        ]
      : []),
    { title: '行号', dataIndex: 'rowNo', key: 'rowNo', width: 60 },
    {
      title: '项目编号',
      key: 'code',
      render: (_: unknown, r: PreviewRow) => r.parsedData.projectCode ?? '—',
    },
    {
      title: '年度',
      key: 'year',
      render: (_: unknown, r: PreviewRow) => r.parsedData.budgetYear ?? '—',
    },
    {
      title: '科目',
      key: 'subj',
      render: (_: unknown, r: PreviewRow) =>
        r.parsedData.subjectName ?? r.parsedData.subjectCode ?? <Text type="secondary">—</Text>,
    },
    {
      title: '金额',
      key: 'amount',
      align: 'right',
      render: (_: unknown, r: PreviewRow) =>
        r.normalizedAmount ? (
          <MoneyText value={r.normalizedAmount} riskOnNegative={false} />
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '业务日期',
      key: 'date',
      render: (_: unknown, r: PreviewRow) => r.parsedData.businessDate ?? '—',
    },
    {
      title: '经办人',
      key: 'handler',
      render: (_: unknown, r: PreviewRow) => r.parsedData.handler ?? '—',
    },
    {
      title: '摘要',
      key: 'summary',
      ellipsis: true,
      render: (_: unknown, r: PreviewRow) => r.parsedData.summary ?? '—',
    },
    {
      title: '业务状态',
      key: 'status',
      render: (_: unknown, r: PreviewRow) => r.parsedData.businessStatus ?? '—',
    },
    {
      title: '备注',
      key: 'remark',
      ellipsis: true,
      render: (_: unknown, r: PreviewRow) => r.parsedData.remark ?? <Text type="secondary">—</Text>,
    },
    {
      title: '错误',
      key: 'errors',
      width: 240,
      render: (_: unknown, r: PreviewRow) =>
        r.errors.length > 0 ? (
          <Space direction="vertical" size={0}>
            {r.errors.map((e, i) => (
              <Text key={i} type="danger" style={{ fontSize: 12 }}>
                {e.field}:{e.message}
              </Text>
            ))}
          </Space>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
  ];
  return (
    <Table<PreviewRow>
      rowKey="rowId"
      columns={columns}
      dataSource={rows}
      pagination={false}
      size="small"
      scroll={{ x: 'max-content' }}
    />
  );
}

function ImportPageInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const projectId = params.id;
  const batchId = search.get('batch') ?? null;

  const [preview, setPreview] = useState<BatchPreview | null>(null);
  // 进入预览模式(batchId 非空)时初始即为 loading;所有 setState 仅在 await 之后。
  const [loading, setLoading] = useState<boolean>(!!batchId);
  const [uploading, setUploading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // 首次/批次切换时拉取预览;effect 体内不调用 setState(全部在 Promise 回调中)。
  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    apiFetch<BatchPreview>(`/api/projects/${projectId}/imports/${batchId}`)
      .then((data) => {
        if (cancelled) return;
        setPreview(data);
        // §10.3 疑似重复默认不勾选;有效行默认全选。
        const sel = new Set<string>();
        data.valid.forEach((r) => sel.add(r.rowId));
        setSelected(sel);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof Error) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [batchId, projectId]);

  const handleBeforeUpload = async (option: UploadRequestOption) => {
    const { file, onSuccess, onError } = option;
    const f = Array.isArray(file) ? file[0] : file;
    if (!(f instanceof File)) {
      onError?.(new Error('文件无效'));
      return false;
    }
    if (!/\.xlsx$/i.test(f.name)) {
      const err = new Error('仅支持 .xlsx 文件');
      onError?.(err);
      message.error(err.message);
      return false;
    }
    setUploading(true);
    try {
      const newBatchId = await uploadExcel(projectId, f);
      onSuccess?.({}, f);
      message.success('解析完成,跳转预览');
      router.push(`/projects/${projectId}/imports?batch=${newBatchId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '上传失败';
      onError?.(e as Error);
      message.error(msg);
    } finally {
      setUploading(false);
    }
    // 返回 false 阻止 antd 默认 ajax 上传。
    return false;
  };

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (!preview) return;
    setConfirming(true);
    try {
      const res = await apiFetch<{ created: number }>(
        `/api/projects/${projectId}/imports/${preview.batchId}/confirm`,
        {
          method: 'POST',
          body: JSON.stringify({ selectedRowIds: [...selected] }),
        },
      );
      message.success(`已导入 ${res.created} 条业务记录`);
      router.push(`/projects/${projectId}/ledger`);
    } catch (e) {
      if (e instanceof Error) message.error(e.message);
    } finally {
      setConfirming(false);
    }
  };

  const stats = useMemo(() => {
    if (!preview) return null;
    return {
      valid: preview.valid.length,
      errors: preview.errors.length,
      duplicates: preview.duplicates.length,
      selected: selected.size,
    };
  }, [preview, selected]);

  if (uploading || (loading && !preview)) return <Skeleton active />;

  // ---- 预览模式 ----
  if (batchId) {
    if (error || !preview) {
      return (
        <Result
          status="warning"
          title="无法加载导入预览"
          subTitle={error ?? '批次可能不存在或已被清理。'}
          extra={
            <Button type="primary" onClick={() => router.push(`/projects/${projectId}/imports`)}>
              重新上传
            </Button>
          }
        />
      );
    }

    const confirmed = preview.status === 'confirmed';

    return (
      <>
        <Title level={3} style={{ marginTop: 0 }}>
          导入预览
        </Title>
        <Space wrap style={{ marginBottom: 16 }}>
          <Button onClick={() => router.push(`/projects/${projectId}/imports`)}>重新上传</Button>
          <Button onClick={() => router.push(`/projects/${projectId}`)}>返回项目详情</Button>
        </Space>

        <Space size="large" style={{ marginBottom: 16 }}>
          <Statistic title="有效行" value={stats?.valid ?? 0} />
          <Statistic title="错误行" value={stats?.errors ?? 0} valueStyle={{ color: '#cf1322' }} />
          <Statistic
            title="疑似重复"
            value={stats?.duplicates ?? 0}
            valueStyle={{ color: '#d48806' }}
          />
          <Statistic title="已勾选" value={stats?.selected ?? 0} />
        </Space>

        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`文件:${preview.fileName}(模板 v${preview.templateVersion})`}
          description={
            confirmed
              ? '该批次已确认入库。'
              : '勾选要导入的行(疑似重复行默认不勾选,可手动勾选强制导入,§10.3)。错误行不可导入,请修正后重新上传。'
          }
        />

        <Card
          size="small"
          title={<span>有效行 ({preview.valid.length})</span>}
          style={{ marginBottom: 16 }}
        >
          <PreviewTable
            rows={preview.valid}
            selectable={!confirmed}
            selected={selected}
            onToggle={toggleRow}
            emptyText="无有效行"
          />
        </Card>

        <Card
          size="small"
          title={
            <span>
              疑似重复行 ({preview.duplicates.length}) <Tag color="warning">默认不导入</Tag>
            </span>
          }
          style={{ marginBottom: 16 }}
        >
          <PreviewTable
            rows={preview.duplicates}
            selectable={!confirmed}
            selected={selected}
            onToggle={toggleRow}
            emptyText="无疑似重复行"
          />
        </Card>

        <Card
          size="small"
          title={<span>错误行 ({preview.errors.length})</span>}
          style={{ marginBottom: 16 }}
        >
          <PreviewTable
            rows={preview.errors}
            selectable={false}
            selected={selected}
            onToggle={toggleRow}
            emptyText="无错误行"
          />
        </Card>

        {!confirmed ? (
          <Space style={{ marginTop: 8 }}>
            <Button
              type="primary"
              loading={confirming}
              disabled={selected.size === 0}
              onClick={handleConfirm}
            >
              确认导入({selected.size} 行)
            </Button>
          </Space>
        ) : (
          <Alert type="success" showIcon message="该批次已确认入库。" />
        )}
      </>
    );
  }

  // ---- 上传模式 ----
  return (
    <>
      <Title level={3} style={{ marginTop: 0 }}>
        Excel 批量导入
      </Title>
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => router.push(`/projects/${projectId}`)}>返回项目详情</Button>
        <Button onClick={() => downloadTemplate().catch((e) => message.error(e.message))}>
          下载模板
        </Button>
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="两阶段导入:上传校验 → 预览确认"
        description={
          <Paragraph style={{ marginBottom: 0 }}>
            上传后将逐行校验(项目编号/年度/叶科目/金额/状态/日期),识别疑似重复行,生成预览。
            在预览页勾选有效行后点击「确认导入」才会写入业务记录。超预算行允许导入(§10.2)。
            请先下载模板按格式填写。
          </Paragraph>
        }
      />

      <Dragger
        accept=".xlsx"
        multiple={false}
        showUploadList={false}
        customRequest={handleBeforeUpload}
        beforeUpload={() => false}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">点击或拖拽 .xlsx 文件到此处上传</p>
        <p className="ant-upload-hint">仅支持单个 .xlsx 文件,需符合模板列顺序</p>
      </Dragger>
    </>
  );
}

export default function ImportPage() {
  // useSearchParams 需在 Suspense 边界内。
  return (
    <Suspense fallback={<Skeleton active />}>
      <ImportPageInner />
    </Suspense>
  );
}
