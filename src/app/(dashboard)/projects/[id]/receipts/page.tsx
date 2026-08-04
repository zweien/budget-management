'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { format } from 'date-fns';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';

import { apiFetch } from '@/lib/api/client';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AmountInput } from '@/components/ui/AmountInput';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Dialog,
  DialogContent,
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
import { MoneyText } from '@/components/ui/MoneyText';
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

/** 到账记录行(对应 GET /receipts 返回,含 creator 名称)。 */
interface ReceiptRow {
  id: string;
  projectId: string;
  /** 到账日期(ISO 字符串)。 */
  receiptDate: string;
  amount: string;
  summary: string | null;
  remark: string | null;
  creatorId: string;
  createdAt: string;
  creator: { id: string; name: string };
}

interface ReceiptListResponse {
  records: ReceiptRow[];
  /** 到账累计(2 位小数字符串)。 */
  cumulative: string;
}

/** 把 receiptDate(ISO/带 T)统一为 YYYY-MM-DD 展示。 */
function formatDate(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd');
}

/** 把时间戳统一为 YYYY-MM-DD HH:mm 展示。 */
function formatDateTime(s: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'yyyy-MM-dd HH:mm');
}

const receiptSchema = z.object({
  receiptDate: z.date({ message: '请选择到账日期' }),
  amount: z.string({ message: '请输入到账金额' }).min(1, '请输入到账金额'),
  summary: z.string().trim().max(200),
  remark: z.string().trim().max(500),
});

type ReceiptFormValues = z.infer<typeof receiptSchema>;

export default function ReceiptsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [records, setRecords] = useState<ReceiptRow[]>([]);
  const [cumulative, setCumulative] = useState<string>('0.00');
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 新增/修改 Dialog。
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ReceiptRow | null>(null);

  const form = useForm<ReceiptFormValues>({
    resolver: zodResolver(receiptSchema),
    defaultValues: { summary: '', remark: '' },
  });

  /** 拉取到账列表 + 累计(项目名由项目壳承载,失败态在此呈现)。 */
  const reload = useCallback(async () => {
    setLoadingRecords(true);
    setFatal(null);
    try {
      const data = await apiFetch<ReceiptListResponse>(`/api/projects/${projectId}/receipts`);
      setRecords(data.records ?? []);
      setCumulative(data.cumulative ?? '0.00');
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 403 || err.status === 404) {
        setFatal('项目可能不存在或您没有访问权限。');
      } else if (e instanceof Error) {
        toast.error(e.message);
      }
    } finally {
      setLoadingRecords(false);
    }
  }, [projectId]);

  // 初次加载(loading 已为 true,仅异步落值)。
  useEffect(() => {
    let cancelled = false;
    apiFetch<ReceiptListResponse>(`/api/projects/${projectId}/receipts`)
      .then((data) => {
        if (!cancelled) {
          setRecords(data.records ?? []);
          setCumulative(data.cumulative ?? '0.00');
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const err = e as Error & { status?: number };
          if (err.status === 403 || err.status === 404) {
            setFatal('项目可能不存在或您没有访问权限。');
          } else if (e instanceof Error) {
            toast.error(e.message);
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingRecords(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /** 打开"新增"Dialog。 */
  const openCreate = () => {
    setEditing(null);
    form.reset({ receiptDate: new Date(), amount: undefined, summary: '', remark: '' });
    setFormOpen(true);
  };

  /** 打开"修改"Dialog,预填当前行。 */
  const openEdit = (row: ReceiptRow) => {
    setEditing(row);
    form.reset({
      receiptDate: new Date(row.receiptDate),
      amount: row.amount,
      summary: row.summary ?? '',
      remark: row.remark ?? '',
    });
    setFormOpen(true);
  };

  /** 提交新增/修改。 */
  const onSubmit = form.handleSubmit(async (values) => {
    const payload = {
      receiptDate: format(values.receiptDate, 'yyyy-MM-dd'),
      amount: values.amount,
      summary: values.summary || null,
      remark: values.remark || null,
    };
    setSubmitting(true);
    try {
      if (editing) {
        await apiFetch<{ record: ReceiptRow }>(
          `/api/projects/${projectId}/receipts/${editing.id}`,
          { method: 'PATCH', body: JSON.stringify(payload) },
        );
        toast.success('已保存修改');
      } else {
        await apiFetch<{ record: ReceiptRow }>(`/api/projects/${projectId}/receipts`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast.success('已登记到账');
      }
      setFormOpen(false);
      await reload();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    } finally {
      setSubmitting(false);
    }
  });

  /** 删除到账记录(AlertDialog 二次确认)。 */
  const handleDelete = async (row: ReceiptRow) => {
    try {
      await apiFetch(`/api/projects/${projectId}/receipts/${row.id}`, { method: 'DELETE' });
      toast.success('已删除');
      await reload();
    } catch (e) {
      if (e instanceof Error) toast.error(e.message);
    }
  };

  if (fatal) {
    return (
      <Alert variant="error">
        <AlertDescription>{fatal}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* 到账累计(参考,§9.1 不作预算上限)。 */}
        <Card className="w-72 p-4">
          <p className="caption-mono">到账累计(参考,不计入预算上限)</p>
          <p className="mt-1.5 text-display-md tabular-nums">
            <MoneyText value={cumulative} riskOnNegative={false} className="text-left" />
          </p>
        </Card>
        <Button onClick={openCreate}>登记到账</Button>
      </div>

      <Alert variant="info">
        <AlertDescription>到账流水仅作参考登记,不参与预算占用或上限校验(§9.1)。</AlertDescription>
      </Alert>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-32">到账日期</TableHead>
              <TableHead className="w-32 text-right">金额</TableHead>
              <TableHead>摘要</TableHead>
              <TableHead>备注</TableHead>
              <TableHead className="w-28">录入人</TableHead>
              <TableHead className="w-40">录入时间</TableHead>
              <TableHead className="w-36">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadingRecords ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))
            ) : records.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                  暂无到账记录
                </TableCell>
              </TableRow>
            ) : (
              records.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="tabular-nums">{formatDate(row.receiptDate)}</TableCell>
                  <TableCell>
                    <MoneyText value={row.amount} riskOnNegative={false} />
                  </TableCell>
                  <TableCell className="max-w-40 truncate" title={row.summary ?? undefined}>
                    {row.summary || <span className="text-mute">—</span>}
                  </TableCell>
                  <TableCell className="max-w-40 truncate" title={row.remark ?? undefined}>
                    {row.remark || <span className="text-mute">—</span>}
                  </TableCell>
                  <TableCell>{row.creator?.name ?? row.creatorId.slice(0, 8)}</TableCell>
                  <TableCell className="tabular-nums">{formatDateTime(row.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                        修改
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-error-deep hover:bg-error-soft"
                          >
                            删除
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>确认删除该到账记录?</AlertDialogTitle>
                            <AlertDialogDescription>
                              到账为参考数据,删除后不可恢复。
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>取消</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => void handleDelete(row)}
                            >
                              删除
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* 新增/修改 Dialog:react-hook-form + zod */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? '修改到账记录' : '登记到账'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="receiptDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>到账日期</FormLabel>
                    <DatePicker value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>到账金额</FormLabel>
                    <FormControl>
                      <AmountInput
                        value={field.value}
                        onChange={field.onChange}
                        aria-invalid={!!form.formState.errors.amount}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="summary"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>摘要</FormLabel>
                    <FormControl>
                      <Input maxLength={200} {...field} />
                    </FormControl>
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
                      <Textarea maxLength={500} rows={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setFormOpen(false)}
                  disabled={submitting}
                >
                  取消
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? '保存中…' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
