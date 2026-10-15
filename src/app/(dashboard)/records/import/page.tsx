'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SettlementImportPreview,
  type SettlementBatchData,
} from '@/components/records/settlement-import-preview';

/**
 * 统一导入入口(业务录入):财务结算单(2025 导出,v3,可含多个项目)。
 * 上传 → 项目映射 → 预览确认;批次承载项目 = 自动预映射的第一个目标项目
 * (未命中时选择承载项目后重传)。系统模板/个人结算单(v1/v2)请在项目内导入页上传。
 */

interface MineBatch {
  batchId: string;
  hostProjectId: string;
  hostProjectName: string;
  fileName: string;
  templateVersion: string;
  status: string;
  createdAt: string;
  rowCount: number;
}

interface MappableProject {
  id: string;
  name: string;
}

export default function UnifiedImportPage() {
  const router = useRouter();

  const [mode, setMode] = useState<'entry' | 'preview'>('entry');
  const [preview, setPreview] = useState<SettlementBatchData | null>(null);
  const [previewHost, setPreviewHost] = useState('');

  // 上传
  const [uploading, setUploading] = useState(false);
  const [needsHost, setNeedsHost] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [hostProjectId, setHostProjectId] = useState('');
  const [mappableProjects, setMappableProjects] = useState<MappableProject[]>([]);

  // 我的进行中批次
  const [mine, setMine] = useState<MineBatch[]>([]);
  const [mineLoading, setMineLoading] = useState(true);

  const loadMine = useCallback(async () => {
    // 不在此处置 loading:挂载 effect 同步调用会触发 set-state-in-effect 规则;
    // 首屏骨架由初始 state 提供,刷新场景直接原位更新。
    try {
      const data = await apiFetch<{ batches: MineBatch[] }>('/api/imports/mine');
      setMine(data.batches ?? []);
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setMineLoading(false);
    }
  }, []);

  // 挂载拉取批次列表(内联请求,与统计页同款;setState 均在 Promise 回调中)。
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ batches: MineBatch[] }>('/api/imports/mine')
      .then((data) => {
        if (!cancelled) setMine(data.batches ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled && e instanceof Error) toast.error(e.message);
      })
      .finally(() => {
        if (!cancelled) setMineLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openPreview = useCallback(async (batchId: string, hostProjectId: string) => {
    try {
      const data = await apiFetch<SettlementBatchData>(
        `/api/projects/${hostProjectId}/imports/${batchId}`,
      );
      setPreviewHost(hostProjectId);
      setPreview(data);
      setMode('preview');
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    }
  }, []);

  const uploadFile = useCallback(
    async (file: File, host?: string) => {
      setUploading(true);
      setNeedsHost(false);
      try {
        const form = new FormData();
        form.append('file', file);
        if (host) form.append('hostProjectId', host);
        const res = await apiFetch<{
          batchId: string | null;
          batchProjectId: string | null;
          needsHost: boolean;
          mappableProjects?: MappableProject[];
        }>('/api/imports/settlement', {
          method: 'POST',
          body: form,
        });
        if (res.needsHost) {
          // 未命中自动预映射:展示承载项目选择后重传。
          setNeedsHost(true);
          setPendingFile(file);
          setMappableProjects(res.mappableProjects ?? []);
          toast.info('未能自动识别目标项目,请选择承载项目后重试');
          return;
        }
        toast.success('解析完成,请核对项目映射与科目');
        await loadMine();
        await openPreview(res.batchId!, res.batchProjectId!);
      } catch (e) {
        if (e instanceof Error) toast.error(e.message);
      } finally {
        setUploading(false);
      }
    },
    [loadMine, openPreview],
  );

  // ---- 预览模式 ----
  if (mode === 'preview' && preview) {
    return (
      <div className="space-y-4">
        <SettlementImportPreview
          projectId={previewHost}
          initialData={preview}
          canEdit
          exitTo="/records/import"
          onExit={() => {
            setMode('entry');
            setPreview(null);
            void loadMine();
          }}
        />
      </div>
    );
  }

  // ---- 入口模式:上传 + 我的批次 ----
  const confirmMine = async (b: MineBatch) => {
    await openPreview(b.batchId, b.hostProjectId);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Records"
        title="导入财务结算单"
        description="财务结算单(2025 导出)统一入口:文件可含多个项目,上传后自动按「科研项目名称」映射并拆分入账。"
      />

      <Card className="p-4">
        <div className="space-y-3">
          <Label className="flex items-center gap-2 text-sm font-medium">
            <Upload className="size-4" />
            上传财务结算单(仅支持 2025 导出格式;系统模板/个人结算单请在项目内导入页上传)
          </Label>
          <input
            type="file"
            accept=".xlsx"
            disabled={uploading}
            className="block w-full cursor-pointer rounded-md border border-border bg-card px-3 py-2 text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm"
            aria-label="选择财务结算单 xlsx 文件"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadFile(f);
              e.target.value = '';
            }}
          />
          {uploading ? <Skeleton className="h-6 w-full" /> : null}
          {needsHost ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
              <span className="text-sm">
                未能自动识别目标项目,请选择承载项目(批次容器;行入账仍按映射):
              </span>
              <Select
                value={hostProjectId || undefined}
                onValueChange={setHostProjectId}
                disabled={uploading}
              >
                <SelectTrigger className="w-72">
                  <SelectValue placeholder="选择承载项目…" />
                </SelectTrigger>
                <SelectContent>
                  {mappableProjects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={!hostProjectId || uploading || !pendingFile}
                onClick={() => pendingFile && void uploadFile(pendingFile, hostProjectId)}
              >
                {uploading ? '上传中…' : '重试上传'}
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-mute">
            同单据编号的冲账重报明细会按单据合并(金额取净额);开支细项末段与科目名一致时自动预选科目;
            文件含多个项目时自动按「科研项目名称」映射,未识别的项目需人工指定。
          </p>
        </div>
      </Card>

      <Card className="p-4">
        <p className="caption-mono mb-2">我的批次(最近 20 条)</p>
        {mineLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : mine.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">暂无批次</p>
        ) : (
          <div className="space-y-1.5">
            {mine.map((b) => (
              <div
                key={b.batchId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{b.fileName}</p>
                  <p className="text-xs text-mute">
                    {b.hostProjectName} · {b.rowCount} 行 ·{' '}
                    {format(new Date(b.createdAt), 'yyyy-MM-dd HH:mm')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {b.status === 'confirmed' ? (
                    <Badge variant="secondary">已导入</Badge>
                  ) : (
                    <Badge variant="warning">进行中</Badge>
                  )}
                  <Button variant="outline" size="sm" onClick={() => void confirmMine(b)}>
                    {b.status === 'confirmed' ? '查看' : '继续'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => router.push('/records')}>
          返回业务录入
        </Button>
      </div>
    </div>
  );
}
