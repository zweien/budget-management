'use client';

import { useRef, useState } from 'react';
import { AlertTriangle, FileUp, Upload } from 'lucide-react';
import { toast } from 'sonner';

import {
  executeMigrationImport,
  previewMigrationImport,
  type MigrationImportPreview,
  type MigrationImportResult,
} from '@/lib/api/migrationPackage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type RowStatus =
  | { kind: 'ok'; label: '可导入' }
  | { kind: 'pendingVersion'; label: '版本偏差,需确认' }
  | { kind: 'pendingOverwrite'; label: '同编号冲突,需勾选覆盖' }
  | { kind: 'hard'; label: '目标有业务数据,硬拒绝' }
  | { kind: 'error'; label: '解析失败' };

/**
 * 迁移包导入(§备份与迁移,仅 ADMIN):两阶段无状态——上传 → 服务端只读预检 →
 * 勾选确认 → 重传同一文件执行(执行端全量重跑守卫)。单 json 或 zip(逐包独立事务)。
 * 由父组件条件渲染(挂载即净态);userOptions 复用列表页为 ADMIN 预拉的用户候选。
 */
export function ImportMigrationPackageDialog({
  userOptions,
  onClose,
  onImported,
}: {
  userOptions: { id: string; name: string }[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<MigrationImportPreview | null>(null);
  const [ownerUserId, setOwnerUserId] = useState<string>('none');
  const [allowSkew, setAllowSkew] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [results, setResults] = useState<MigrationImportResult[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const anyVersionSkew = !!preview?.files.some((f) => f.inspection?.versionSkew);
  const anySkeletonConflict = !!preview?.files.some((f) => f.inspection?.conflict?.skeleton);

  const rowStatus = (f: MigrationImportPreview['files'][number]): RowStatus => {
    if (!f.ok || !f.inspection) return { kind: 'error', label: '解析失败' };
    const ins = f.inspection;
    if (ins.conflict && !ins.conflict.skeleton)
      return { kind: 'hard', label: '目标有业务数据,硬拒绝' };
    if (ins.versionSkew && !allowSkew) return { kind: 'pendingVersion', label: '版本偏差,需确认' };
    if (ins.conflict?.skeleton && !overwrite)
      return { kind: 'pendingOverwrite', label: '同编号冲突,需勾选覆盖' };
    return { kind: 'ok', label: '可导入' };
  };

  const importableCount = preview
    ? preview.files.filter((f) => rowStatus(f).kind === 'ok').length
    : 0;

  const reset = () => {
    setFile(null);
    setPreview(null);
    setResults(null);
    setAllowSkew(false);
    setOverwrite(false);
  };

  const handleFile = async (f: File) => {
    if (!/\.(json|zip)$/i.test(f.name)) {
      toast.error('仅支持 .json(单包)或 .zip(批量)文件');
      return;
    }
    setFile(f);
    setPreviewing(true);
    setResults(null);
    try {
      const p = await previewMigrationImport(f);
      setPreview(p);
      if (p.files.some((x) => !x.ok)) {
        toast.warning(`${p.files.filter((x) => !x.ok).length} 个文件预检未通过,详见列表`);
      }
    } catch (e) {
      setFile(null);
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setPreviewing(false);
    }
  };

  const handleExecute = async () => {
    if (!file) return;
    setExecuting(true);
    try {
      const res = await executeMigrationImport(file, {
        ownerUserId: ownerUserId === 'none' ? undefined : ownerUserId,
        overwrite,
        allowSkew,
      });
      setResults(res.results);
      const failed = res.results.filter((r) => r.status === 'failed').length;
      toast.success(`导入完成:成功 ${res.imported}${failed > 0 ? `,失败 ${failed}` : ''}`);
      if (res.imported > 0) onImported();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入迁移包</DialogTitle>
          <DialogDescription>
            上传迁移包文件(.json 单包或 .zip 批量,批量逐包独立导入、一包失败不牵连其余);
            仅含项目与预算骨架,不含台账/成员/附件。执行前会再次全量校验。
          </DialogDescription>
        </DialogHeader>

        {/* 阶段一:选择文件(有结果后隐藏入口,提供重新选择) */}
        {!results ? (
          <div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={previewing || executing}
              className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
            >
              <FileUp className="size-6" />
              {previewing
                ? '预检中…'
                : file
                  ? `已选择:${file.name}(点击重新选择)`
                  : '点击选择 .json / .zip 迁移包文件'}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".json,.zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = '';
              }}
            />
          </div>
        ) : null}

        {/* 阶段二:预检列表 */}
        {preview && !results ? (
          <div className="space-y-3">
            <ul className="max-h-64 space-y-1 overflow-auto rounded-md border border-border p-2">
              {preview.files.map((f) => {
                const s = rowStatus(f);
                const ins = f.inspection;
                return (
                  <li
                    key={f.name}
                    className="flex flex-wrap items-center gap-2 rounded px-2 py-1 hover:bg-muted/50"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <span className="font-mono text-[13px]">{ins?.code ?? f.name}</span>
                      {ins ? ` ${ins.name}` : ''}
                    </span>
                    {ins?.pendingInPackage ? <Badge variant="warning">含待审批单</Badge> : null}
                    <Badge
                      variant={
                        s.kind === 'ok'
                          ? 'success'
                          : s.kind === 'hard' || s.kind === 'error'
                            ? 'error'
                            : 'secondary'
                      }
                    >
                      {s.label}
                    </Badge>
                  </li>
                );
              })}
            </ul>

            <div className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm">负责人认领(OWNER)</Label>
                <Select value={ownerUserId} onValueChange={setOwnerUserId}>
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder="选择用户" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">不认领(占位最早管理员)</SelectItem>
                    {userOptions.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {ownerUserId === 'none' ? (
                <p className="text-xs text-muted-foreground">
                  未认领时负责人占位为目标环境最早的管理员(不代表成员关系,可稍后在「成员管理」认领)
                </p>
              ) : null}
              {anyVersionSkew ? (
                <label className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    checked={allowSkew}
                    onCheckedChange={(v) => setAllowSkew(v === true)}
                    disabled={executing}
                  />
                  <span className="text-sm">
                    确认按当前版本导入存在版本偏差的包(等价 CLI --allow-skew,自担 schema 错位风险)
                  </span>
                </label>
              ) : null}
              {anySkeletonConflict ? (
                <label className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    checked={overwrite}
                    onCheckedChange={(v) => setOverwrite(v === true)}
                    disabled={executing}
                  />
                  <span className="text-sm">
                    覆盖同编号的骨架态既有项目(等价 CLI --overwrite;目标侧成员一并移除)
                  </span>
                </label>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 阶段三:执行结果 */}
        {results ? (
          <div className="space-y-2">
            <ul className="max-h-64 space-y-1 overflow-auto rounded-md border border-border p-2 text-sm">
              {results.map((r, i) => (
                <li
                  key={`${r.code ?? 'unknown'}-${i}`}
                  className="flex flex-wrap items-center gap-2 rounded px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-[13px]">{r.code ?? '?'}</span>
                    {r.name ? ` ${r.name}` : ''}
                  </span>
                  {r.status === 'imported' ? (
                    <Badge variant="success">
                      已导入{r.report?.replacedExisting ? '(覆盖)' : ''}
                    </Badge>
                  ) : (
                    <Badge variant="error" title={r.reason}>
                      失败
                    </Badge>
                  )}
                  {r.status === 'failed' && r.reason ? (
                    <span className="w-full text-xs text-muted-foreground">{r.reason}</span>
                  ) : null}
                  {r.report && r.report.warnings.length > 0 ? (
                    <span className="w-full text-xs text-muted-foreground">
                      {r.report.warnings.join(';')}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {preview && !results && importableCount === 0 && preview.files.length > 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            <AlertTriangle className="size-4 shrink-0" />
            当前没有可导入的包:按列表状态处理后(勾选确认/取消冲突),或换一个文件。
          </div>
        ) : null}

        <DialogFooter>
          {results ? (
            <>
              <Button variant="outline" onClick={reset} disabled={executing}>
                继续导入其他文件
              </Button>
              <Button onClick={onClose}>完成</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={executing}>
                取消
              </Button>
              <Button
                onClick={() => void handleExecute()}
                disabled={!preview || executing || importableCount === 0}
              >
                <Upload className="size-4" />
                {executing ? '导入中…' : `导入 ${importableCount} 个项目`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
