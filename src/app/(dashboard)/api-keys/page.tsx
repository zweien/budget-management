'use client';

import { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { Copy, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * 「API 凭证」自助管理(ADR 0001):签发/撤销个人 API Key 供 coding agent 使用。
 * scope 只收窄不放大:实际权限 = 用户权限 ∩ 凭证范围;无人值守模式在服务端
 * 硬排除作废/审批/成员管理。明文仅创建时展示一次,凭证管理接口拒绝机器凭证。
 */

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  unattended: boolean;
  tier: string;
  projectScope: string;
  projectIds: string[] | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

const TIER_LABEL: Record<string, string> = { read: '只读', write: '读写', full: '完整' };
const TIER_DESC: Record<string, string> = {
  read: '仅查询/统计/台账,任何写操作被拒',
  write: '加业务记录、导入确认、到账登记',
  full: '与你本人的权限相同(仍受确认策略约束)',
};
const EXPIRY_OPTIONS = [
  { value: 'never', label: '永不过期', days: null },
  { value: '30', label: '30 天', days: 30 },
  { value: '90', label: '90 天', days: 90 },
  { value: '365', label: '365 天', days: 365 },
];

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');
  const [unattended, setUnattended] = useState(true);
  const [tier, setTier] = useState('read');
  const [projectScope, setProjectScope] = useState<'all' | 'selected'>('all');
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('30');

  const [created, setCreated] = useState<{ plaintext: string; prefix: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [revoking, setRevoking] = useState(false);

  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiFetch<{ keys: ApiKeyRow[] }>('/api/api-keys'),
      apiFetch<ProjectOption[]>('/api/me/projects'),
    ])
      .then(([keyRes, projectRes]) => {
        if (cancelled) return;
        setKeys(keyRes.keys);
        setProjects(projectRes);
      })
      .catch((e) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  const resetForm = () => {
    setName('');
    setUnattended(true);
    setTier('read');
    setProjectScope('all');
    setSelectedProjectIds([]);
    setExpiry('30');
  };

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      const days = EXPIRY_OPTIONS.find((o) => o.value === expiry)?.days ?? null;
      const res = await apiFetch<{ key: ApiKeyRow; plaintext: string }>('/api/api-keys', {
        method: 'POST',
        body: JSON.stringify({
          name,
          unattended,
          tier,
          projectScope,
          projectIds: projectScope === 'selected' ? selectedProjectIds : undefined,
          expiresInDays: days,
        }),
      });
      setCreateOpen(false);
      resetForm();
      setCreated({ plaintext: res.plaintext, prefix: res.key.prefix });
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await apiFetch(`/api/api-keys/${revokeTarget.id}/revoke`, { method: 'POST' });
      toast.success(`已撤销 ${revokeTarget.prefix}…`);
      setRevokeTarget(null);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '撤销失败');
    } finally {
      setRevoking(false);
    }
  };

  const copyPlaintext = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.plaintext);
    toast.success('已复制');
  };

  const canSubmit =
    name.trim().length > 0 && (projectScope === 'all' || selectedProjectIds.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="API 凭证"
        description="为 coding agent 签发个人 API Key:权限不高于本人、按档位与项目范围收窄;无人值守模式下作废/审批/成员管理被服务端拦截。明文仅创建时展示一次。"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            创建凭证
          </Button>
        }
      />

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>凭证</TableHead>
              <TableHead>模式</TableHead>
              <TableHead>档位</TableHead>
              <TableHead>项目范围</TableHead>
              <TableHead>有效期至</TableHead>
              <TableHead>最近使用</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  加载中…
                </TableCell>
              </TableRow>
            ) : keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  还没有凭证;创建一把即可让 coding agent 以你的身份操作系统。
                </TableCell>
              </TableRow>
            ) : (
              keys.map((k) => (
                <TableRow key={k.id} className={cn(k.revokedAt && 'opacity-50')}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell className="font-mono text-xs">{k.prefix}…</TableCell>
                  <TableCell>
                    <Badge variant={k.unattended ? 'secondary' : 'outline'}>
                      {k.unattended ? '无人值守' : '在场交互'}
                    </Badge>
                  </TableCell>
                  <TableCell>{TIER_LABEL[k.tier] ?? k.tier}</TableCell>
                  <TableCell>
                    {k.projectScope === 'selected'
                      ? `指定 ${Array.isArray(k.projectIds) ? k.projectIds.length : 0} 个项目`
                      : '全部项目'}
                  </TableCell>
                  <TableCell>
                    {k.expiresAt ? format(new Date(k.expiresAt), 'yyyy-MM-dd') : '—'}
                  </TableCell>
                  <TableCell>
                    {k.lastUsedAt ? format(new Date(k.lastUsedAt), 'MM-dd HH:mm') : '从未'}
                  </TableCell>
                  <TableCell>
                    {k.revokedAt ? (
                      <Badge variant="error">已撤销</Badge>
                    ) : k.expiresAt && new Date(k.expiresAt) <= new Date() ? (
                      <Badge variant="error">已过期</Badge>
                    ) : (
                      <Badge variant="success">有效</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!k.revokedAt && (
                      <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(k)}>
                        撤销
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* 创建凭证 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>创建 API 凭证</DialogTitle>
            <DialogDescription>
              凭证以你的身份操作,权限只能收窄;作废/审批/成员管理在无人值守模式下被服务端拦截。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="key-name">名称</Label>
              <Input
                id="key-name"
                placeholder="如:张三项目导入机器人"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>认证模式</Label>
                <Select
                  value={unattended ? 'u' : 'a'}
                  onValueChange={(v) => setUnattended(v === 'u')}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="u">无人值守(推荐)</SelectItem>
                    <SelectItem value="a">在场交互</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>档位</Label>
                <Select value={tier} onValueChange={setTier}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read">只读</SelectItem>
                    <SelectItem value="write">读写</SelectItem>
                    <SelectItem value="full">完整</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-mute">{TIER_DESC[tier]}</p>
            <div className="flex flex-col gap-1.5">
              <Label>项目范围</Label>
              <Select
                value={projectScope}
                onValueChange={(v) => setProjectScope(v as 'all' | 'selected')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部我有权限的项目</SelectItem>
                  <SelectItem value="selected">指定项目</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {projectScope === 'selected' && (
              <div className="max-h-40 overflow-y-auto rounded-md border border-border p-2">
                {projects.map((p) => (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent"
                  >
                    <Checkbox
                      checked={selectedProjectIds.includes(p.id)}
                      onCheckedChange={(checked) =>
                        setSelectedProjectIds((prev) =>
                          checked ? [...prev, p.id] : prev.filter((id) => id !== p.id),
                        )
                      }
                    />
                    <span className="truncate">
                      {p.name}
                      <span className="ml-1 font-mono text-xs text-mute">{p.code}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label>有效期</Label>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button disabled={!canSubmit || submitting} onClick={handleCreate}>
              {submitting ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 明文仅此一次 */}
      <Dialog open={created !== null} onOpenChange={(o) => !o && setCreated(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>凭证已创建({created?.prefix}…)</DialogTitle>
            <DialogDescription>
              明文仅此一次展示,关闭后无法再次查看;泄露或不再使用时请撤销。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {created?.plaintext}
            </code>
            <Button variant="outline" size="icon" onClick={copyPlaintext} aria-label="复制凭证">
              <Copy className="size-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>我已保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 撤销确认 */}
      <Dialog open={revokeTarget !== null} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>撤销凭证</DialogTitle>
            <DialogDescription>
              撤销后使用该凭证的请求将立即 401,不影响其他凭证。确定撤销「{revokeTarget?.name}」(
              {revokeTarget?.prefix}…)吗?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" disabled={revoking} onClick={handleRevoke}>
              {revoking ? '撤销中…' : '撤销'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
