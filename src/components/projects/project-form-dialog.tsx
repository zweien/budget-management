'use client';

import { useEffect, useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/**
 * 把 @db.Date 的 ISO 串(YYYY-MM-DDT00:00:00Z)按**日历日**解析成本地 Date。
 * 直接 new Date(iso) 在 UTC 以西时区会后退一天(§codex P2)。
 */
function parseDateOnly(s?: string | null): Date | undefined {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})/.exec(s) : null;
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const projectFormSchema = z.object({
  code: z.string().trim().min(1, '请输入项目编号'),
  name: z.string().trim().min(1, '请输入项目名称'),
  level: z.string().trim(),
  projectType: z.string().trim(),
  undertakingUnit: z.string().trim(),
  range: z.custom<DateRange>().optional(),
  remark: z.string().trim(),
  /** 负责人(仅新建;获得该项目 OWNER 成员编辑权),默认创建者自己。 */
  ownerId: z.string().trim(),
});

type ProjectFormValues = z.infer<typeof projectFormSchema>;

/** /api/me 当前用户。 */
export interface DialogCurrentUser {
  id: string;
  name: string;
  role: 'ADMIN' | 'USER';
}

export interface DialogUserOption {
  id: string;
  name: string;
}

/** 编辑目标(新建时传 null);字段与 updateProject 可改范围一致(code 不可改)。 */
export interface ProjectFormTarget {
  id: string;
  code: string;
  name: string;
  level: string | null;
  projectType?: string | null;
  undertakingUnit?: string | null;
  startDate: string | null;
  endDate: string | null;
  remark: string | null;
}

interface ProjectFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑目标;null = 新建。 */
  editing: ProjectFormTarget | null;
  /** 当前用户(新建时默认负责人为创建者)。 */
  me: DialogCurrentUser | null;
  /** 负责人候选(仅新建模式使用;仅管理员能拉到候选列表)。 */
  userOptions: DialogUserOption[];
  /** 保存成功回调(create 返回新项目,edit 返回更新后的项目)。 */
  onSaved: (project: { id: string } & Record<string, unknown>, mode: 'create' | 'edit') => void;
}

/**
 * 新建 / 编辑项目共用弹窗(§项目管理:编辑与归档)。
 * - 新建:POST /api/projects(code 唯一冲突内联到编号字段);
 * - 编辑:PATCH /api/projects/:id,编号只读(全局唯一标识,各处引用不改),
 *   负责人不展示(负责人变更涉及成员表联动,本期不做)。
 */
export function ProjectFormDialog({
  open,
  onOpenChange,
  editing,
  me,
  userOptions,
  onSaved,
}: ProjectFormDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const isEdit = !!editing;

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: {
      code: '',
      name: '',
      level: '',
      projectType: '',
      undertakingUnit: '',
      remark: '',
      ownerId: '',
    },
  });

  // 打开时按模式预填(编辑回填现有值;新建清空并默认负责人为自己)。
  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.reset({
        code: editing.code,
        name: editing.name,
        level: editing.level ?? '',
        projectType: editing.projectType ?? '',
        undertakingUnit: editing.undertakingUnit ?? '',
        remark: editing.remark ?? '',
        ownerId: '',
        range: editing.startDate
          ? {
              from: parseDateOnly(editing.startDate),
              to: parseDateOnly(editing.endDate),
            }
          : undefined,
      });
    } else {
      form.reset({
        code: '',
        name: '',
        level: '',
        projectType: '',
        undertakingUnit: '',
        remark: '',
        ownerId: me?.id ?? '',
        range: undefined,
      });
    }
  }, [open, editing, me?.id, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      if (isEdit && editing) {
        const updated = await apiFetch<{ id: string } & Record<string, unknown>>(
          `/api/projects/${editing.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              name: values.name,
              level: values.level || null,
              projectType: values.projectType || null,
              undertakingUnit: values.undertakingUnit || null,
              startDate: values.range?.from?.toISOString() ?? null,
              endDate: values.range?.to?.toISOString() ?? null,
              remark: values.remark || null,
            }),
          },
        );
        toast.success('项目信息已更新');
        onOpenChange(false);
        onSaved(updated, 'edit');
      } else {
        const created = await apiFetch<{ id: string } & Record<string, unknown>>('/api/projects', {
          method: 'POST',
          body: JSON.stringify({
            code: values.code,
            name: values.name,
            level: values.level || null,
            projectType: values.projectType || null,
            undertakingUnit: values.undertakingUnit || null,
            startDate: values.range?.from?.toISOString() ?? null,
            endDate: values.range?.to?.toISOString() ?? null,
            remark: values.remark || null,
            ownerId: values.ownerId || undefined,
          }),
        });
        toast.success('项目已创建');
        onOpenChange(false);
        onSaved(created, 'create');
      }
    } catch (e) {
      const err = e as Error & { status?: number };
      // 编号唯一冲突(仅新建)内联到字段,其余走全局提示。
      if (!isEdit && err.status === 409) {
        form.setError('code', { message: err.message });
      } else {
        toast.error(err.message);
      }
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑项目' : '新建项目'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '项目编号不可修改;修改即时生效并记入操作日志。'
              : '创建后可在项目详情页编制初始预算。'}
          </DialogDescription>
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
                    <Input
                      placeholder="系统内唯一"
                      {...field}
                      disabled={isEdit}
                      className={isEdit ? 'font-mono text-[13px]' : undefined}
                    />
                  </FormControl>
                  {isEdit ? (
                    <p className="text-xs text-muted-foreground">编号为系统标识,创建后不可修改。</p>
                  ) : (
                    <FormMessage />
                  )}
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
            {!isEdit ? (
              <FormField
                control={form.control}
                name="ownerId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>负责人</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="默认为自己" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {userOptions.map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {u.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      负责人将获得该项目的编辑权限(OWNER 成员);之后可在项目详情页调整。
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
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
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                取消
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? (isEdit ? '保存中…' : '创建中…') : isEdit ? '保存' : '创建'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
