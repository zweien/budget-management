'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, FileText, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';

import { apiFetch, downloadFile } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import {
  DEFAULT_DETAIL_FIELDS,
  DEFAULT_SUMMARY_COLUMNS,
  DETAIL_FIELD_DEFS,
  DETAIL_FIELD_KEYS,
  SUMMARY_COLUMN_DEFS,
  SUMMARY_COLUMN_KEYS,
  serializeFundingReportOptions,
  type DetailFieldKey,
  type SummaryColumnKey,
} from '@/lib/fundingReport';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * 「经费报告」生成页(CONTEXT.md「经费报告」):选项目 + 科目展示层级(默认二级)
 * + 汇总列/明细字段勾选与排序 → 下载 Word。选择记忆存 localStorage(全局一份)。
 * 口径:已支付=完成记账(PAID)、未支付=应付未付;作废记录不计入报告。
 */

interface ProjectOption {
  id: string;
  code: string;
  name: string;
  archivedAt: string | null;
}

interface SubjectNode {
  id: string;
  level: number;
}

/** /api/export/progress 返回体(值只有阶段文案与数字,无业务数据)。 */
interface ProgressPayload {
  progress: {
    phase: string;
    percent: number;
    status: 'running' | 'done' | 'error';
    error: string | null;
  };
}

/** 生成进度卡片状态。 */
interface GenerationState {
  status: 'running' | 'done' | 'error';
  percent: number;
  phase: string;
  error: string | null;
}

/** 勾选 + 顺序的可排序条目(顺序含未勾选项,生成时只取勾选项的相对顺序)。 */
type SelectableItem<K extends string> = { key: K; checked: boolean };

const STORAGE_KEY = 'funding-report-config-v1';

interface StoredConfig {
  summary: SelectableItem<SummaryColumnKey>[];
  fields: SelectableItem<DetailFieldKey>[];
  level: string;
}

/** 默认配置:汇总勾模板 5 列、明细勾模板 4 列,层级默认二级。 */
function defaultConfig(): StoredConfig {
  return {
    summary: SUMMARY_COLUMN_DEFS.map((d) => ({
      key: d.key,
      checked: DEFAULT_SUMMARY_COLUMNS.includes(d.key),
    })),
    fields: DETAIL_FIELD_DEFS.map((d) => ({
      key: d.key,
      checked: DEFAULT_DETAIL_FIELDS.includes(d.key),
    })),
    level: '2',
  };
}

/** localStorage 恢复:逐条校验 key 合法性并去重,损坏/缺项回落默认(池演进时补全条目)。 */
function loadStoredConfig(): StoredConfig {
  const fallback = defaultConfig();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    const merge = <K extends string>(
      stored: unknown,
      valid: readonly K[],
      defaults: SelectableItem<K>[],
    ): SelectableItem<K>[] => {
      if (!Array.isArray(stored)) return defaults;
      const seen = new Set<K>();
      const picked: SelectableItem<K>[] = [];
      for (const item of stored) {
        if (typeof item !== 'object' || item === null || !('key' in item)) continue;
        const key = (item as { key: unknown }).key;
        if (
          typeof key === 'string' &&
          (valid as readonly string[]).includes(key) &&
          !seen.has(key as K)
        ) {
          seen.add(key as K);
          picked.push({ key: key as K, checked: (item as { checked: unknown }).checked === true });
        }
      }
      // 池内 key 可能新增:存储里没有的条目补到末尾(默认勾选)。
      return [...picked, ...defaults.filter((it) => !seen.has(it.key))];
    };
    const level =
      parsed.level === 'all' ||
      (typeof parsed.level === 'string' && /^[1-9]\d{0,1}$/.test(parsed.level))
        ? parsed.level
        : fallback.level;
    return {
      summary: merge(parsed.summary, SUMMARY_COLUMN_KEYS, fallback.summary),
      fields: merge(parsed.fields, DETAIL_FIELD_KEYS, fallback.fields),
      level,
    };
  } catch {
    return fallback;
  }
}

function moveItem<K extends string>(
  items: SelectableItem<K>[],
  index: number,
  delta: -1 | 1,
): SelectableItem<K>[] {
  const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** 勾选 + 上移/下移列表(汇总列与明细字段共用)。 */
function SelectableList<K extends string>({
  items,
  onToggle,
  onMove,
  emptyHint,
}: {
  items: SelectableItem<K>[];
  onToggle: (key: K, checked: boolean) => void;
  onMove: (index: number, delta: -1 | 1) => void;
  emptyHint: string;
}) {
  return (
    <div className="space-y-1" role="group" aria-label="列选择">
      {items.map((item, index) => (
        <div
          key={item.key}
          className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5"
        >
          <Checkbox
            id={`col-${item.key}`}
            checked={item.checked}
            onCheckedChange={(checked) => onToggle(item.key, checked === true)}
          />
          <span className="flex-1 text-sm">{LABELS[item.key]}</span>
          <span className="flex">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={index === 0}
              onClick={() => onMove(index, -1)}
              aria-label="上移"
            >
              <ChevronUp />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={index === items.length - 1}
              onClick={() => onMove(index, 1)}
              aria-label="下移"
            >
              <ChevronDown />
            </Button>
          </span>
        </div>
      ))}
      {items.every((it) => !it.checked) ? (
        <p className="text-xs text-destructive">{emptyHint}</p>
      ) : null}
    </div>
  );
}

/** 汇总列 + 明细字段统一 label 映射(key 空间不重叠,可直接合并)。 */
const LABELS: Record<string, string> = {
  ...Object.fromEntries(SUMMARY_COLUMN_DEFS.map((d) => [d.key, d.label])),
  ...Object.fromEntries(DETAIL_FIELD_DEFS.map((d) => [d.key, d.label])),
};

const LEVEL_LABELS = ['一级', '二级', '三级', '四级', '五级', '六级', '七级', '八级'];

type SubjectsState = { status: 'idle' | 'loading' | 'loaded' | 'error'; maxLevel: number | null };

export default function FundingReportPage() {
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [projectId, setProjectId] = useState<string>('');
  const [subjects, setSubjects] = useState<SubjectsState>({ status: 'idle', maxLevel: null });
  const [generation, setGeneration] = useState<GenerationState | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [config, setConfig] = useState<StoredConfig>(defaultConfig);
  const maxLevel = subjects.maxLevel;
  const loadingSubjects = subjects.status === 'loading';
  const generating = generation?.status === 'running';

  // localStorage 恢复:rAF 时机应用(与列偏好回落同款,避免 effect 内同步 setState)。
  // 持久化 effect 等 restore 完成后才写:否则挂载瞬间会把默认配置写回、覆盖原偏好。
  const restoredRef = useRef(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setConfig(loadStoredConfig());
      restoredRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    if (!restoredRef.current) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* 存储失败不影响功能 */
    }
  }, [config]);

  useEffect(() => {
    apiFetch<ProjectOption[]>('/api/projects?includeArchived=1')
      .then((rows) => setProjects(rows))
      .catch(() => {
        setProjects([]);
        toast.error('项目列表加载失败');
      });
  }, []);

  // 选中项目后取科目树实际深度,层级选择只列有效档位(loading 态由选择事件置位,
  // effect 内只做异步回填,规避 effect 内同步 setState)。
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    apiFetch<{ subjects: SubjectNode[] }>(`/api/projects/${projectId}/subjects`)
      .then(({ subjects: nodes }) => {
        if (cancelled) return;
        setSubjects({
          status: 'loaded',
          maxLevel: nodes.length > 0 ? Math.max(...nodes.map((s) => s.level)) : null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setSubjects({ status: 'error', maxLevel: null });
        toast.error('科目树加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const onProjectChange = useCallback((id: string) => {
    setProjectId(id);
    // loading 态在选择事件里置位(空项目回落 idle),effect 只负责异步回填。
    setSubjects(id ? { status: 'loading', maxLevel: null } : { status: 'idle', maxLevel: null });
  }, []);

  // 层级选择:1..maxLevel + 全部(至最深层)。
  const levelOptions = useMemo(() => {
    const options: { value: string; label: string }[] = [];
    for (let level = 1; level <= (maxLevel ?? 2); level += 1) {
      options.push({ value: String(level), label: LEVEL_LABELS[level - 1] ?? `${level} 级` });
    }
    if (maxLevel !== null && maxLevel > 1)
      options.push({ value: 'all', label: `全部（至最深层）` });
    return options;
  }, [maxLevel]);

  // 项目树比记忆的层级浅时收敛(超出 maxLevel 的数字档位回落「全部」)。
  const effectiveLevel = useMemo(() => {
    if (config.level === 'all') return maxLevel !== null && maxLevel > 1 ? 'all' : '1';
    const level = Number.parseInt(config.level, 10);
    if (Number.isNaN(level)) return '2';
    if (maxLevel !== null && level > maxLevel) return maxLevel > 1 ? 'all' : '1';
    return String(Math.max(1, level));
  }, [config.level, maxLevel]);

  const selectedProject = projects?.find((p) => p.id === projectId) ?? null;
  const checkedSummary = config.summary.filter((it) => it.checked).map((it) => it.key);
  const checkedFields = config.fields.filter((it) => it.checked).map((it) => it.key);
  const canGenerate = Boolean(projectId) && checkedSummary.length > 0 && checkedFields.length > 0;

  const abortRef = useRef<AbortController | null>(null);

  /** 取消生成:中断下载请求;服务端进度条目自然过期。 */
  const onCancelGenerate = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const onGenerate = useCallback(async () => {
    if (!selectedProject) return;
    const progressId = crypto.randomUUID();
    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();
    setGeneration({ status: 'running', percent: 0, phase: '准备中', error: null });
    setElapsedMs(0);

    // 500ms 一拍:轮询服务端进度 + 刷新已耗时(进度端点 404/失败时静默,不阻塞下载)。
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
      apiFetch<ProgressPayload>(`/api/export/progress?id=${progressId}`)
        .then(({ progress }) => {
          setGeneration((prev) =>
            prev?.status === 'running'
              ? {
                  ...prev,
                  percent: progress.percent,
                  phase: progress.phase,
                  status: progress.status,
                  error: progress.error,
                }
              : prev,
          );
        })
        .catch(() => {
          /* 进度查询失败不影响下载本身 */
        });
    }, 500);

    try {
      const query = serializeFundingReportOptions({
        level: effectiveLevel === 'all' ? 'all' : Number.parseInt(effectiveLevel, 10),
        summaryColumns: checkedSummary,
        detailFields: checkedFields,
      });
      await downloadFile(
        `/api/projects/${projectId}/export/funding-report?${query}&progress=${progressId}`,
        `经费报告-${selectedProject.code}.docx`,
        { signal: controller.signal },
      );
      clearInterval(timer);
      setGeneration((prev) =>
        prev ? { ...prev, status: 'done', percent: 100, phase: '完成' } : prev,
      );
      toast.success('经费报告已生成，浏览器开始下载');
    } catch (error) {
      clearInterval(timer);
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      setGeneration(null);
      if (!aborted) {
        toast.error(error instanceof Error ? error.message : '生成失败，请重试');
      }
    } finally {
      clearInterval(timer);
      abortRef.current = null;
    }
  }, [selectedProject, projectId, effectiveLevel, checkedSummary, checkedFields]);

  // 生成成功后短暂展示 100% 再收起进度条。
  useEffect(() => {
    if (generation?.status !== 'done') return;
    const t = setTimeout(() => setGeneration(null), 2000);
    return () => clearTimeout(t);
  }, [generation?.status]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader
        eyebrow="报告"
        title="生成经费报告"
        description="单项目全周期执行报告(Word):一级科目汇总 + 分科目完成记账/应付未付明细;作废记录不计入。"
        actions={
          <Button onClick={onGenerate} disabled={!canGenerate || generating}>
            {generating ? <Loader2 className="animate-spin" /> : <FileText />}
            生成 Word 报告
          </Button>
        }
      />

      {generation ? (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              {generation.status === 'running' ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm">
                    {generation.status === 'error'
                      ? `生成失败：${generation.error ?? '未知错误'}`
                      : generation.phase}
                  </p>
                  {generation.status === 'running' ? (
                    <span className="caption-mono shrink-0">
                      {Math.round(generation.percent)}% · {(elapsedMs / 1000).toFixed(0)}s
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full transition-all duration-300',
                      generation.status === 'error' ? 'bg-destructive' : 'bg-primary',
                    )}
                    style={{
                      width: `${generation.status === 'running' ? generation.percent : 100}%`,
                    }}
                  />
                </div>
              </div>
              {generation.status === 'running' ? (
                <Button variant="outline" size="sm" onClick={onCancelGenerate}>
                  <X />
                  取消
                </Button>
              ) : generation.status === 'error' ? (
                <Button variant="outline" size="sm" onClick={() => setGeneration(null)}>
                  知道了
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>项目与科目层级</CardTitle>
            <CardDescription>
              科目展示层级同时决定汇总表行与明细分节;非叶层级金额取子树上卷。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="project">项目</Label>
              <Select value={projectId} onValueChange={onProjectChange}>
                <SelectTrigger id="project" className="w-full">
                  <SelectValue placeholder={projects === null ? '加载中…' : '选择项目'} />
                </SelectTrigger>
                <SelectContent>
                  {(projects ?? []).map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.code} · {project.name}
                      {project.archivedAt ? '（已归档）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedProject?.archivedAt ? <Badge variant="outline">已归档项目</Badge> : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="level">科目展示层级</Label>
              <Select
                value={effectiveLevel}
                onValueChange={(value) => setConfig((prev) => ({ ...prev, level: value }))}
                disabled={!projectId || maxLevel === null || loadingSubjects}
              >
                <SelectTrigger id="level" className="w-full">
                  <SelectValue placeholder={loadingSubjects ? '加载中…' : '选择项目后可选层级'} />
                </SelectTrigger>
                <SelectContent>
                  {levelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">默认二级(与财务模板一致)。</p>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:row-span-2">
          <CardHeader>
            <CardTitle>汇总表列</CardTitle>
            <CardDescription>万元口径;列头沿用财务模板文字,勾选并排序。</CardDescription>
          </CardHeader>
          <CardContent>
            <SelectableList
              items={config.summary}
              emptyHint="至少勾选一个数值列,否则无法生成。"
              onToggle={(key, checked) =>
                setConfig((prev) => ({
                  ...prev,
                  summary: prev.summary.map((it) => (it.key === key ? { ...it, checked } : it)),
                }))
              }
              onMove={(index, delta) =>
                setConfig((prev) => ({ ...prev, summary: moveItem(prev.summary, index, delta) }))
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>明细字段</CardTitle>
            <CardDescription>
              元口径;完成记账与应付未付两节同列,深科目项目建议勾「科目」。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SelectableList
              items={config.fields}
              emptyHint="至少勾选一个字段,否则无法生成。"
              onToggle={(key, checked) =>
                setConfig((prev) => ({
                  ...prev,
                  fields: prev.fields.map((it) => (it.key === key ? { ...it, checked } : it)),
                }))
              }
              onMove={(index, delta) =>
                setConfig((prev) => ({ ...prev, fields: moveItem(prev.fields, index, delta) }))
              }
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
