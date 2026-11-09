'use client';

import { useState } from 'react';
import { Package } from 'lucide-react';
import { toast } from 'sonner';

import {
  exportMigrationPackages,
  type MigrationPackagesManifest,
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
import { Switch } from '@/components/ui/switch';

/** 批量导出弹窗的项目选项(来自列表页当前筛选结果)。 */
export interface MigrationExportProjectOption {
  code: string;
  name: string;
  archivedAt: string | null;
}

/**
 * 批量导出迁移包(§备份与迁移):勾选项目 → zip(每项目一个 migration-<编号>.json
 * + manifest.json)。默认跳过存在待审批单的项目,开关打开后随包带出(等价逐项目
 * --force)。由父组件条件渲染(挂载即默认全选当前筛选结果,关闭即卸载重置)。
 */
export function ExportMigrationPackagesDialog({
  projects,
  onClose,
}: {
  projects: MigrationExportProjectOption[];
  onClose: () => void;
}) {
  // 挂载时初始化为全选(父组件保证 projects 已是当前筛选结果)。
  const [checked, setChecked] = useState<Set<string>>(() => new Set(projects.map((p) => p.code)));
  const [includePending, setIncludePending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<MigrationPackagesManifest | null>(null);

  const allChecked = projects.length > 0 && checked.size === projects.length;

  const toggle = (code: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const handleExport = async () => {
    const codes = [...checked];
    if (codes.length === 0) {
      toast.error('请至少选择一个项目');
      return;
    }
    setExporting(true);
    try {
      const manifest = await exportMigrationPackages(codes, includePending);
      setResult(manifest);
      toast.success(`已导出 ${manifest.exported.length} 个项目迁移包`);
      if (manifest.skippedPending.length > 0 || manifest.failed.length > 0) {
        toast.warning(
          `跳过 ${manifest.skippedPending.length} 个(含待审批单)、失败 ${manifest.failed.length} 个,详见弹窗内结果`,
        );
      }
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>批量导出迁移包</DialogTitle>
          <DialogDescription>
            产出 zip(每项目一个 migration-&lt;编号&gt;.json + manifest.json),仅含项目与预算骨架,
            不含台账/成员/附件;目标环境经 CLI 导入。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <Label className="text-sm">
            已选 {checked.size} / {projects.length} 个项目(默认全选当前筛选结果)
          </Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setChecked(allChecked ? new Set() : new Set(projects.map((p) => p.code)))
            }
          >
            {allChecked ? '清空' : '全选'}
          </Button>
        </div>

        <ul className="max-h-72 space-y-1 overflow-auto rounded-md border border-border p-2">
          {projects.map((p) => (
            <li key={p.code}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-muted/50">
                <Checkbox
                  checked={checked.has(p.code)}
                  onCheckedChange={() => toggle(p.code)}
                  disabled={exporting}
                />
                <span className="font-mono text-[13px]">{p.code}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
                {p.archivedAt ? <Badge variant="secondary">已归档</Badge> : null}
              </label>
            </li>
          ))}
          {projects.length === 0 ? (
            <li className="px-2 py-4 text-center text-sm text-muted-foreground">
              当前筛选结果为空
            </li>
          ) : null}
        </ul>

        <div className="flex items-center justify-between rounded-md border border-border p-3">
          <div>
            <Label htmlFor="include-pending" className="text-sm">
              包含存在待审批单的项目
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              默认跳过在途单据;打开后在途单随包带出,由目标环境管理员继续审批
            </p>
          </div>
          <Switch
            id="include-pending"
            checked={includePending}
            onCheckedChange={setIncludePending}
            disabled={exporting}
          />
        </div>

        {result && (result.skippedPending.length > 0 || result.failed.length > 0) ? (
          <div className="max-h-32 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
            {result.skippedPending.length > 0 ? (
              <p>跳过(含待审批单):{result.skippedPending.map((s) => s.code).join('、')}</p>
            ) : null}
            {result.failed.length > 0 ? (
              <p className="mt-1">
                失败:
                {result.failed.map((f) => `${f.code}(${f.reason})`).join('、')}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={exporting}>
            关闭
          </Button>
          <Button onClick={() => void handleExport()} disabled={exporting || projects.length === 0}>
            <Package className="size-4" />
            {exporting ? '导出中…' : `导出 ${checked.size} 个项目`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
