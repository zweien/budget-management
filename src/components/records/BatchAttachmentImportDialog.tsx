'use client';

import { useCallback, useRef, useState } from 'react';
import { format } from 'date-fns';
import { FileStack, Upload, X } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  ALLOWED_ATTACHMENT_SPEC,
  MAX_ATTACHMENT_BYTES_DEFAULT,
  validateAttachment,
} from '@/lib/attachments/config';
import {
  matchAttachmentPreview,
  uploadAttachment,
  type AttachmentMatchCandidate,
  type AttachmentMatchFileResult,
} from '@/lib/api/attachments';

/**
 * 批量附件导入(CONTEXT.md「批量附件导入」):一次选中多个附件文件,
 * 按单据编号前缀匹配挂到既有业务记录。两阶段:文件名(+指纹)匹配预览 →
 * 核对后逐文件串行上传(复用单传接口,内容重复由服务端跳重)。
 *
 * 项目内入口传 projectId(项目范围匹配);统一入口不传(跨项目,
 * 同号跨项目在预览行内人工指定)。
 */

/** 单批文件数上限(与服务端 parseMatchPreviewFiles 一致)。 */
const MAX_BATCH_FILES = 100;

/** 白名单扩展名(单一事实源 ALLOWED_ATTACHMENT_SPEC,file input accept 用)。 */
const ACCEPT = ALLOWED_ATTACHMENT_SPEC.flatMap((s) => [...s.extensions]).join(',');

interface BatchAttachmentImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 项目内入口传项目上下文;统一入口(跨项目)不传。 */
  projectId?: string;
  /** 全部上传结束后的回调(供外层刷新附件计数等;可选)。 */
  onChanged?: () => void;
}

/** 预览行(客户端状态:result = 服务端匹配结果;chosen = 歧义行人工指定的候选)。 */
interface PreviewRow {
  file: File;
  contentHash?: string;
  result: AttachmentMatchFileResult;
  chosenRecordId?: string;
}

/** 上传后的逐文件终态(报告用)。 */
type ReportRow = {
  name: string;
  outcome: 'uploaded' | 'skipped-duplicate' | 'skipped-unmatched' | 'skipped-unresolved' | 'failed';
  message?: string;
};

const UNMATCHED_REASON_LABEL: Record<string, string> = {
  'no-record': '未匹配到同号记录',
  'void-only': '仅命中已作废记录',
  'no-permission': '命中项目无编辑权限',
};

/** 浏览器 WebCrypto 算 SHA-256 hex;不可用(非安全上下文)时返回 undefined,退化为无预检标记。 */
async function sha256Hex(file: File): Promise<string | undefined> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return undefined;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

export function BatchAttachmentImportDialog({
  open,
  onOpenChange,
  projectId,
  onChanged,
}: BatchAttachmentImportDialogProps) {
  const [phase, setPhase] = useState<'select' | 'matching' | 'preview' | 'uploading' | 'report'>(
    'select',
  );
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [report, setReport] = useState<ReportRow[]>([]);
  const [progress, setProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  // 上传批次守卫:上传期间禁止关闭对话框(避免误触中断串行队列)。
  const uploadingRef = useRef(false);

  // 关闭时回到初始态(在 onOpenChange 处理器里重置,不在 effect 里同步 setState)。
  const resetState = () => {
    setPhase('select');
    setRows([]);
    setReport([]);
    setProgress(0);
    uploadingRef.current = false;
  };
  const handleOpenChange = (next: boolean) => {
    if (uploadingRef.current) return; // 上传中不允许关闭
    if (!next) resetState();
    onOpenChange(next);
  };

  const startMatch = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;
      if (files.length > MAX_BATCH_FILES) {
        toast.error(`单批最多 ${MAX_BATCH_FILES} 个文件,请分批上传`);
        return;
      }
      // 客户端即时校验(扩展名/MIME 双白名单 + 默认 50MB;服务端仍为权威)。
      const invalid = files.filter(
        (f) =>
          !validateAttachment(
            { name: f.name, type: f.type || 'application/octet-stream', size: f.size },
            MAX_ATTACHMENT_BYTES_DEFAULT,
          ).ok,
      );
      if (invalid.length > 0) {
        toast.error(
          `${invalid.length} 个文件不合规(类型不在白名单或超过 50MB):${invalid
            .slice(0, 3)
            .map((f) => f.name)
            .join('、')}${invalid.length > 3 ? ' 等' : ''}`,
        );
        return;
      }

      setPhase('matching');
      setProgress(0);
      try {
        const inputs: Array<{ name: string; contentHash?: string }> = [];
        const hashByName = new Map<string, string | undefined>();
        for (const file of files) {
          const hash = await sha256Hex(file);
          hashByName.set(file.name, hash);
          inputs.push({ name: file.name, ...(hash ? { contentHash: hash } : {}) });
          setProgress((p) => p + 1);
        }
        const matched = await matchAttachmentPreview(inputs, projectId);
        setRows(
          matched.files.map((result) => ({
            file: files.find((f) => f.name === result.name) ?? files[0],
            contentHash: hashByName.get(result.name),
            result,
          })),
        );
        setPhase('preview');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '匹配预览失败');
        setPhase('select');
      }
    },
    [projectId],
  );

  /** 行的上传目标(matched 唯一候选;歧义行取人工指定)。 */
  const targetOf = useCallback((row: PreviewRow): AttachmentMatchCandidate | null => {
    if (row.result.status === 'matched') return row.result.record;
    if (row.result.status === 'ambiguous') {
      return row.result.candidates.find((c) => c.recordId === row.chosenRecordId) ?? null;
    }
    return null;
  }, []);

  const uploadableCount = rows.filter((r) => targetOf(r)).length;
  const duplicateMarked = rows.filter((r) => targetOf(r)?.duplicate).length;

  const startUpload = useCallback(async () => {
    setPhase('uploading');
    setProgress(0);
    uploadingRef.current = true;
    const results: ReportRow[] = [];
    let uploaded = 0;
    let changed = false;
    try {
      for (const row of rows) {
        const target = targetOf(row);
        if (!target) {
          results.push({
            name: row.file.name,
            outcome: row.result.status === 'unmatched' ? 'skipped-unmatched' : 'skipped-unresolved',
            message:
              row.result.status === 'unmatched'
                ? UNMATCHED_REASON_LABEL[row.result.reason]
                : '同号跨项目,未指定目标项目',
          });
          continue;
        }
        try {
          const outcome = await uploadAttachment(
            target.projectId,
            target.recordId,
            row.file,
            'record',
            { via: 'docno-batch' },
          );
          if (outcome.status === 'duplicate') {
            results.push({
              name: row.file.name,
              outcome: 'skipped-duplicate',
              message: `与「${outcome.existing.fileName}」内容相同`,
            });
          } else {
            uploaded += 1;
            changed = true;
            results.push({ name: row.file.name, outcome: 'uploaded' });
          }
        } catch (e) {
          results.push({
            name: row.file.name,
            outcome: 'failed',
            message: e instanceof Error ? e.message : '上传失败',
          });
        }
        setProgress((p) => p + 1);
      }
    } finally {
      uploadingRef.current = false;
    }
    setReport(results);
    setPhase('report');
    const failed = results.filter((r) => r.outcome === 'failed').length;
    const skipped = results.length - uploaded - failed;
    if (failed === 0) {
      toast.success(`批量附件导入完成:成功 ${uploaded} 个,跳过 ${skipped} 个`);
    } else {
      toast.error(`批量附件导入完成:成功 ${uploaded},跳过 ${skipped},失败 ${failed}(见明细)`);
    }
    if (changed) onChanged?.();
  }, [rows, onChanged, targetOf]);

  const removeRow = (name: string) => setRows((prev) => prev.filter((r) => r.file.name !== name));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileStack className="size-4" />
            批量上传附件(按单据编号匹配)
          </DialogTitle>
          <DialogDescription>
            文件名以单据编号开头(如 TYBX…_01_说明.pdf)即可自动挂到对应业务记录;
            同号多文件全挂同一条记录;内容与已有附件相同的文件自动跳过。
            {projectId ? '在本项目范围内匹配。' : '跨项目匹配:同号跨项目时需逐文件指定目标项目。'}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto py-1">
          {phase === 'select' || phase === 'matching' ? (
            <label
              className={cn(
                'flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed bg-card px-6 py-10 text-center transition-colors',
                dragOver
                  ? 'border-ring bg-accent/60'
                  : 'border-hairline-strong hover:border-ring hover:bg-accent/40',
              )}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (phase === 'matching') return;
                void startMatch(e.dataTransfer.files);
              }}
            >
              <Upload className="size-8 text-mute" />
              <p className="text-sm">
                {phase === 'matching'
                  ? `正在计算内容指纹并匹配 ${progress}/${rows.length || ''}…`
                  : `点击或拖拽附件文件到此处(多选,单批 ≤ ${MAX_BATCH_FILES} 个)`}
              </p>
              <p className="text-xs text-mute">
                支持格式:{ACCEPT.replaceAll(',', ' / ')};单文件 ≤ 50MB
              </p>
              <input
                type="file"
                multiple
                accept={ACCEPT}
                disabled={phase === 'matching'}
                className="hidden"
                aria-label="选择多个附件文件"
                onChange={(e) => {
                  if (e.target.files?.length) void startMatch(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          ) : null}

          {phase === 'preview' ? (
            <>
              <p className="text-xs text-mute">
                将上传 {uploadableCount} 个
                {duplicateMarked > 0
                  ? `(其中 ${duplicateMarked} 个与已有附件内容相同,上传时将跳过)`
                  : ''}
                ; 其余 {rows.length - uploadableCount} 个未匹配/待指定,不会上传。
              </p>
              <div className="space-y-1.5">
                {rows.map((row) => (
                  <div
                    key={row.file.name}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={row.file.name}>
                        {row.file.name}
                      </p>
                      {row.result.status === 'matched' ? (
                        <p className="text-xs text-mute">
                          {projectId ? '' : `${row.result.record.projectName} · `}
                          {row.result.record.summary} · ¥{row.result.record.amount} ·{' '}
                          {format(new Date(row.result.record.businessDate), 'yyyy-MM-dd')} · 已有{' '}
                          {row.result.record.attachmentCount} 个附件
                          {row.result.duplicate ? (
                            <span className="text-warning">
                              {' '}
                              · 已有相同内容({row.result.duplicateOfFileName}),将跳过
                            </span>
                          ) : null}
                        </p>
                      ) : row.result.status === 'unmatched' ? (
                        <p className="text-xs text-warning">
                          {UNMATCHED_REASON_LABEL[row.result.reason]}——不会上传
                        </p>
                      ) : (
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-xs text-warning">同号跨项目,请指定:</span>
                          <Select
                            value={row.chosenRecordId ?? ''}
                            onValueChange={(v) =>
                              setRows((prev) =>
                                prev.map((r) =>
                                  r.file.name === row.file.name ? { ...r, chosenRecordId: v } : r,
                                ),
                              )
                            }
                          >
                            <SelectTrigger className="h-7 w-72">
                              <SelectValue placeholder="选择目标项目…" />
                            </SelectTrigger>
                            <SelectContent>
                              {row.result.candidates.map((c) => (
                                <SelectItem key={c.recordId} value={c.recordId}>
                                  {c.projectName} · {c.summary} · ¥{c.amount}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {row.result.status === 'matched' ? (
                        row.result.duplicate ? (
                          <Badge variant="warning">内容重复</Badge>
                        ) : (
                          <Badge variant="secondary">已匹配</Badge>
                        )
                      ) : row.result.status === 'unmatched' ? (
                        <Badge variant="warning">未匹配</Badge>
                      ) : row.chosenRecordId ? (
                        <Badge variant="secondary">已指定</Badge>
                      ) : (
                        <Badge variant="warning">待指定</Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={`移除 ${row.file.name}`}
                        onClick={() => removeRow(row.file.name)}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {phase === 'uploading' ? (
            <div className="py-10 text-center text-sm text-mute">
              正在上传 {progress}/{rows.length}…(逐文件串行,单个失败不影响其余)
            </div>
          ) : null}

          {phase === 'report' ? (
            <div className="space-y-1.5">
              {report.map((r) => (
                <div
                  key={r.name}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <p className="min-w-0 flex-1 truncate text-sm" title={r.name}>
                    {r.name}
                  </p>
                  <div className="flex items-center gap-2 text-xs">
                    {r.message ? <span className="text-mute">{r.message}</span> : null}
                    {r.outcome === 'uploaded' ? (
                      <Badge variant="success">已上传</Badge>
                    ) : r.outcome === 'skipped-duplicate' ? (
                      <Badge variant="warning">跳过(重复)</Badge>
                    ) : r.outcome === 'failed' ? (
                      <Badge variant="error">失败</Badge>
                    ) : (
                      <Badge variant="outline">未上传</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          {phase === 'preview' ? (
            <>
              <Button variant="outline" onClick={() => setPhase('select')}>
                重新选择
              </Button>
              <Button onClick={() => void startUpload()} disabled={uploadableCount === 0}>
                开始上传({uploadableCount} 个)
              </Button>
            </>
          ) : null}
          {phase === 'report' ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setPhase('select');
                  setRows([]);
                  setReport([]);
                }}
              >
                继续下一批
              </Button>
              <Button onClick={() => handleOpenChange(false)}>完成</Button>
            </>
          ) : null}
          {(phase === 'select' || phase === 'matching') && rows.length === 0 ? (
            <Button variant="ghost" onClick={() => handleOpenChange(false)}>
              取消
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
