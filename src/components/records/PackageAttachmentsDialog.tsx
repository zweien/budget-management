'use client';

import { useMemo, useState } from 'react';
import { FolderArchive } from 'lucide-react';
import { toast } from 'sonner';

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
import { packageAttachmentsBySubject } from '@/lib/api/attachments';
import { ensureExtension } from '@/lib/attachments/packagePath';

const DEFAULT_TEMPLATE = '{date}_{amount}_{summary}_{original}';
const ALL_YEAR = '__ALL__';
/** 占位符清单:token 点击插入模板;desc 供「各占位符含义」说明区与按钮悬停提示。 */
const TOKENS: Array<{ token: string; desc: string }> = [
  { token: '{date}', desc: '申请日期(yyyy-mm-dd)' },
  { token: '{amount}', desc: '金额(两位小数,如 1200.00)' },
  { token: '{handler}', desc: '经办人姓名' },
  { token: '{subject}', desc: '叶科目名称' },
  { token: '{summary}', desc: '摘要(超 40 字截断)' },
  { token: '{status}', desc: '状态码(PLACEHOLDER/CONTRACT/FINANCE_APPROVAL/PAID)' },
  { token: '{year}', desc: '预算年度(如 2026)' },
  { token: '{original}', desc: '原文件名(含扩展名)' },
];

// 预览用的样例数据(固定,直观展示各占位符效果)。
const PREVIEW_CTX: Record<string, string> = {
  date: '2026-08-05',
  amount: '1200.00',
  handler: '张三',
  subject: '设备购置费',
  summary: '差旅费',
  status: 'PAID',
  year: '2026',
  original: '发票.pdf',
};
const PREVIEW_FOLDER = '直接费/设备费/设备购置费';

interface PackageAttachmentsDialogProps {
  projectId: string;
  yearOptions: number[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PackageAttachmentsDialog({
  projectId,
  yearOptions,
  open,
  onOpenChange,
}: PackageAttachmentsDialogProps) {
  const [year, setYear] = useState<string>(ALL_YEAR);
  const [template, setTemplate] = useState<string>(DEFAULT_TEMPLATE);
  const [busy, setBusy] = useState(false);

  const previewName = useMemo(() => {
    // 与服务端同规则:空模板回落默认模板(路由对空 template 用 DEFAULT_TEMPLATE)。
    const tpl = template.trim() || DEFAULT_TEMPLATE;
    const rendered = tpl.replace(/\{(\w+)\}/g, (full, key: string) => {
      return PREVIEW_CTX[key] ?? full;
    });
    // 与服务端 renderFilename 同规则:模板未含 {original} 时也补原文件扩展名。
    return ensureExtension(rendered, PREVIEW_CTX.original);
  }, [template]);

  const handlePackage = async () => {
    setBusy(true);
    try {
      await packageAttachmentsBySubject(projectId, {
        year: year === ALL_YEAR ? undefined : Number(year),
        template: template.trim() || undefined,
      });
      toast.success('打包下载已开始');
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打包失败');
    } finally {
      setBusy(false);
    }
  };

  const insertToken = (token: string) => {
    setTemplate((prev) => prev + token);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderArchive className="size-4" />
            按科目打包附件
          </DialogTitle>
          <DialogDescription>
            将项目全部科目的附件按预算目录层级整理成文件夹打包,便于整理经费报告。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">年度</label>
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="全部年度" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_YEAR}>全部年度</SelectItem>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">文件名模板</label>
            <input
              className="flex w-full rounded-md border border-hairline-strong bg-background px-3 py-2 text-sm"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={DEFAULT_TEMPLATE}
            />
            <div className="flex flex-wrap gap-1">
              {TOKENS.map((t) => (
                <button
                  key={t.token}
                  type="button"
                  onClick={() => insertToken(t.token)}
                  title={t.desc}
                  className="rounded border border-hairline px-1.5 py-0.5 font-mono text-xs hover:bg-accent"
                >
                  {t.token}
                </button>
              ))}
            </div>
            {/* 各占位符含义:默认展开、可折叠,说明与插入按钮同源(TOKENS)。 */}
            <details open className="text-xs">
              <summary className="w-fit cursor-pointer select-none text-mute hover:text-foreground">
                各占位符含义
              </summary>
              <ul className="mt-1.5 space-y-1 rounded-md border border-hairline bg-card px-3 py-2">
                {TOKENS.map((t) => (
                  <li key={t.token} className="flex gap-2">
                    <span className="w-20 shrink-0 font-mono text-mute">{t.token}</span>
                    <span>{t.desc}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-mute">
                规则:未知占位符原样保留;模板为空用默认模板;文件名始终以原文件扩展名结尾;非法字符替换为下划线;同目录同名自动追加
                (1)(2)。
              </p>
            </details>
          </div>

          <div className="space-y-1 rounded-md bg-accent/40 p-3 text-xs">
            <p className="font-medium text-foreground">预览</p>
            <p className="break-all font-mono text-mute">
              {PREVIEW_FOLDER}/{previewName || '发票.pdf'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={handlePackage} disabled={busy}>
            {busy ? '打包中…' : '打包下载'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
