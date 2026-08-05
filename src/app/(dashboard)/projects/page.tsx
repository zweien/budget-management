'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { FolderKanban, Plus, Search, X } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import type { DateRange } from 'react-day-picker';

import { apiFetch } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  level: string | null;
  startDate: string | null;
  endDate: string | null;
  remark: string | null;
}

const createSchema = z.object({
  code: z.string().trim().min(1, '请输入项目编号'),
  name: z.string().trim().min(1, '请输入项目名称'),
  level: z.string().trim(),
  projectType: z.string().trim(),
  undertakingUnit: z.string().trim(),
  range: z.custom<DateRange>().optional(),
  remark: z.string().trim(),
});

type CreateFormValues = z.infer<typeof createSchema>;

const formatDate = (d: string | null) => (d ? format(new Date(d), 'yyyy-MM-dd') : '—');

export default function ProjectsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  // 初始即为 true,避免 mount effect 内同步 setState(react-hooks/set-state-in-effect)。
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      code: '',
      name: '',
      level: '',
      projectType: '',
      undertakingUnit: '',
      remark: '',
    },
  });

  const loadProjects = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const data = await apiFetch<ProjectRow[]>('/api/projects');
      setRows(data);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // 首次加载 loading 已为 true,无需同步 setState;后续 setState 均在 await 之后(异步)。
    // 数据拉取是 effect 的合法用途,禁用 set-state-in-effect(本场景无级联渲染风险)。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadProjects(false);
  }, []);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter(
      (r) => r.code.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw),
    );
  }, [rows, keyword]);

  const openCreateDialog = () => {
    form.reset();
    setDialogOpen(true);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const payload = {
        code: values.code,
        name: values.name,
        level: values.level || null,
        projectType: values.projectType || null,
        undertakingUnit: values.undertakingUnit || null,
        startDate: values.range?.from?.toISOString() ?? null,
        endDate: values.range?.to?.toISOString() ?? null,
        remark: values.remark || null,
      };
      const created = await apiFetch<ProjectRow>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast.success('项目已创建');
      setDialogOpen(false);
      setRows((prev) => [created, ...prev]);
    } catch (e) {
      const err = e as Error & { status?: number };
      // 项目编号唯一冲突(409)内联到字段,其余走全局提示。
      if (err.status === 409) {
        form.setError('code', { message: err.message });
      } else {
        toast.error(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <div className="space-y-6">
      {/* 页头:caption-mono 眉题 + display-md 负字距标题(DESIGN.md) */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="caption-mono">Projects</p>
          <h1 className="text-display-md">项目管理</h1>
        </div>
        <Button onClick={openCreateDialog}>
          <Plus />
          新建项目
        </Button>
      </div>

      {/* 工具行 */}
      <div className="relative w-full max-w-72">
        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-mute" />
        <Input
          className="pr-8 pl-8"
          placeholder="按项目编号 / 名称搜索"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        {keyword ? (
          <button
            type="button"
            aria-label="清空搜索"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm text-mute transition-colors hover:text-foreground"
            onClick={() => setKeyword('')}
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {/* 数据表:canvas 卡 + hairline + caption-mono 表头(ex-data-table-cell) */}
      {loading ? (
        <div className="rounded-lg border border-border bg-card shadow-l2">
          <div className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </div>
      ) : rows.length === 0 ? (
        /* ex-empty-state-card:soft 面 + 宽松内边距 + 引导 */
        <div className="flex flex-col items-center gap-3 rounded-lg bg-muted/60 px-6 py-16 text-center">
          <FolderKanban className="size-8 text-mute" />
          <p className="text-sm text-muted-foreground">暂无项目</p>
          <Button onClick={openCreateDialog}>
            <Plus />
            新建项目
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-40">项目编号</TableHead>
                <TableHead>项目名称</TableHead>
                <TableHead className="w-28">级别</TableHead>
                <TableHead className="w-56">起止时间</TableHead>
                <TableHead className="w-28">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                    无匹配「{keyword}」的项目
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((r) => (
                  <TableRow key={r.id}>
                    {/* 编号属技术标识,用 mono(DESIGN.md code 字体) */}
                    <TableCell className="font-mono text-[13px]">{r.code}</TableCell>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell>{r.level ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatDate(r.startDate)} ~ {formatDate(r.endDate)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="link"
                        size="sm"
                        className="px-0"
                        onClick={() => router.push(`/projects/${r.id}`)}
                      >
                        查看详情
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="border-t border-border px-4 py-2 text-xs text-mute tabular-nums">
            共 {filtered.length} 个项目
          </div>
        </div>
      )}

      {/* 新建项目 Dialog:react-hook-form + zod */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建项目</DialogTitle>
            <DialogDescription>创建后可在项目详情页编制初始预算。</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>项目编号</FormLabel>
                    <FormControl>
                      <Input placeholder="系统内唯一" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>项目名称</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="level"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>级别</FormLabel>
                      <FormControl>
                        <Input placeholder="如:国家级 / 省级" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="projectType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>项目类型</FormLabel>
                      <FormControl>
                        <Input placeholder="如:基础研究" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="undertakingUnit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>承担单位</FormLabel>
                    <FormControl>
                      <Input placeholder="如:XX 研究所" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="range"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>起止时间</FormLabel>
                    <DateRangePicker
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="选择起止时间"
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Textarea rows={3} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                  disabled={submitting}
                >
                  取消
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? '创建中…' : '创建'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
