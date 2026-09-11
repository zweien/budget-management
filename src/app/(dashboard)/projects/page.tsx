'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { Archive, FolderKanban, Pencil, Plus, RotateCcw, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Column,
  type ColumnFiltersState,
  type FilterFn,
  type SortingState,
} from '@tanstack/react-table';

import { apiFetch } from '@/lib/api/client';
import {
  ProjectFormDialog,
  type DialogCurrentUser,
  type DialogUserOption,
  type ProjectFormTarget,
} from '@/components/projects/project-form-dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { ColumnSettingsPopover, useStoredColumnVisibility } from '@/components/ui/column-settings';
import { HeaderFilter } from '@/components/ui/data-table-filter';
import { Button } from '@/components/ui/button';
import { TableEmpty } from '@/components/ui/table-pagination';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { dateRange, numberRange, textContains } from '@/lib/table/filter-fns';

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  level: string | null;
  projectType: string | null;
  /** 预算类型(§包干制):GENERAL / LUMP_SUM。 */
  budgetMode: string;
  undertakingUnit: string | null;
  startDate: string | null;
  endDate: string | null;
  remark: string | null;
  archivedAt: string | null;
  /** 项目负责人 = 当前 OWNER 成员(§codex P2:成员管理变更后 ownerId 会漂移)。 */
  members: { user: { id: string; name: string } }[];
  /** 总经费(当前口径);未编制初始预算的项目为 null。 */
  projectBudget: { currentAmount: string } | null;
  createdAt: string;
  /** 行级编辑权(ADMIN 或该项目 OWNER):编辑/归档/恢复按钮的门控。 */
  canEdit: boolean;
}

const formatDate = (d: string | null) => (d ? format(new Date(d), 'yyyy-MM-dd') : '—');

/** 值清单严格语义(与 ValuesFilter 契约一致):undefined=未筛选(全过);
 *  显式数组(含取消全选的空集)按命中判断——空集不显示任何行。 */
const valuesStrict: FilterFn<ProjectRow> = (row, columnId, filterValue) => {
  if (filterValue === undefined) return true;
  return (filterValue as unknown[]).includes(row.getValue(columnId));
};

/** 负责人列(行值为姓名数组):同上严格语义,任一勾选姓名命中即保留。 */
const membersFilter: FilterFn<ProjectRow> = (row, columnId, filterValue) => {
  if (filterValue === undefined) return true;
  const names = row.getValue<string[]>(columnId);
  return (filterValue as unknown[]).some((v) => names.includes(v as string));
};

/** 值清单表头(命名组件:values 筛选共用,选项经 props 注入)。 */
function ValuesHeader({
  column,
  title,
  options,
  valueLabels,
}: {
  column: Column<ProjectRow, unknown>;
  title: string;
  options: string[];
  valueLabels?: Record<string, string>;
}) {
  return (
    <HeaderFilter
      column={column}
      title={title}
      type="values"
      options={options}
      valueLabels={valueLabels}
    />
  );
}

/** 表头宽度/对齐(与旧手写表一致)。 */
const HEAD_CLASS: Record<string, string> = {
  code: 'w-40',
  members: 'w-28',
  budgetMode: 'w-24',
  projectBudget: 'w-36 text-right',
  level: 'w-20',
  projectType: 'w-28',
  undertakingUnit: 'w-36',
  startDate: 'w-56',
  remark: 'max-w-40',
  createdAt: 'w-28',
  actions: 'w-64',
};

const distinctSorted = (vals: (string | null | undefined)[]): string[] =>
  [...new Set(vals.map((v) => v?.trim()).filter((v): v is string => !!v))].sort();

export default function ProjectsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  // 初始即为 true,避免 mount effect 内同步 setState(react-hooks/set-state-in-effect)。
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  /** 是否包含已归档项目(项目管理:归档可恢复,开关切换查看)。 */
  const [showArchived, setShowArchived] = useState(false);
  // 列显隐偏好(cookie 持久化,与录入页同款交互);TanStack 受控 state 驱动。
  const [columnVisibility, toggleColumnVisibility] =
    useStoredColumnVisibility('ui.projects.columns');

  // 表头筛选(客户端组合)与排序。
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [sorting, setSorting] = useState<SortingState>([]);

  // 新建/编辑共用弹窗;editing = null 表示新建。
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectFormTarget | null>(null);
  // 归档确认目标。
  const [archiveTarget, setArchiveTarget] = useState<ProjectRow | null>(null);
  const [archiving, setArchiving] = useState(false);

  // 当前用户(角色决定新建入口可见性)+ 负责人候选(仅管理员可拉取用户列表)。
  const [me, setMe] = useState<DialogCurrentUser | null>(null);
  const [userOptions, setUserOptions] = useState<DialogUserOption[]>([]);
  // 归档/恢复等动作完成后 bump,触发下方唯一加载点重拉(§codex P2:
  // 手动 reload 不参与 effect 的取消守卫,与开关切换并发时会互相覆盖)。
  const [listVersion, setListVersion] = useState(0);
  // 请求序号:仅最新请求可落结果(与统计页同款守卫)。
  const reqSeqRef = useRef(0);

  useEffect(() => {
    // 当前用户(新建入口门控);管理员顺带预拉负责人候选(仅 ADMIN 可调 /api/users)。
    // 项目列表首拉由下方 showArchived effect 统一负责(§codex P2:两个 effect 各自
    // 发请求会互相覆盖——先发出的默认列表请求可能晚于含归档请求返回)。
    apiFetch<DialogCurrentUser>('/api/me')
      .then((u) => {
        setMe(u);
        if (u.role === 'ADMIN') {
          return apiFetch<DialogUserOption[]>('/api/users').then(setUserOptions);
        }
        return undefined;
      })
      .catch(() => undefined);
  }, []);

  // 项目列表唯一加载点:首拉 + 「显示已归档」切换 + 动作后重拉
  // (loading 初始 true,首拉完成后关闭;setState 全在 await 之后)。
  useEffect(() => {
    const seq = ++reqSeqRef.current;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await apiFetch<ProjectRow[]>(
          `/api/projects${showArchived ? '?includeArchived=1' : ''}`,
        );
        if (!cancelled && seq === reqSeqRef.current) setRows(data);
      } catch (e) {
        if (!cancelled && seq === reqSeqRef.current) {
          toast.error(e instanceof Error ? e.message : '加载项目失败');
        }
      } finally {
        if (!cancelled && seq === reqSeqRef.current) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [showArchived, listVersion]);

  // 顶部关键词:编号/名称包含(与列头筛选叠加,先过关键词再进 TanStack)。
  const keywordFiltered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return rows;
    return rows.filter(
      (r) => r.code.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw),
    );
  }, [rows, keyword]);

  // 值清单候选:从当前列表数据动态去重(Excel 行为,零后端改动)。
  const memberOptions = useMemo(
    () => distinctSorted(rows.flatMap((r) => r.members.map((m) => m.user.name))),
    [rows],
  );
  const levelOptions = useMemo(() => distinctSorted(rows.map((r) => r.level)), [rows]);
  const projectTypeOptions = useMemo(() => distinctSorted(rows.map((r) => r.projectType)), [rows]);
  const undertakingUnitOptions = useMemo(
    () => distinctSorted(rows.map((r) => r.undertakingUnit)),
    [rows],
  );

  const openCreateDialog = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEditDialog = (r: ProjectRow) => {
    setEditing({
      id: r.id,
      code: r.code,
      name: r.name,
      level: r.level,
      projectType: r.projectType,
      budgetMode: r.budgetMode,
      undertakingUnit: r.undertakingUnit,
      startDate: r.startDate,
      endDate: r.endDate,
      remark: r.remark,
    });
    setDialogOpen(true);
  };

  const handleSaved = (
    project: { id: string } & Record<string, unknown>,
    mode: 'create' | 'edit',
  ) => {
    setRows((prev) => {
      if (mode === 'create') {
        // 新建:POST 返回值不含 OWNER 成员关系 → 走服务端重拉,避免负责人列显示错人。
        setListVersion((v) => v + 1);
        return prev;
      }
      // 编辑:就地替换(归档状态不变;编辑不改负责人/成员)。
      return prev.map((r) =>
        r.id === project.id
          ? {
              ...r,
              name: String(project.name ?? r.name),
              level: (project.level as string | null) ?? null,
              projectType: (project.projectType as string | null) ?? null,
              budgetMode: (project.budgetMode as string | undefined) ?? r.budgetMode,
              undertakingUnit: (project.undertakingUnit as string | null) ?? null,
              startDate: (project.startDate as string | null) ?? null,
              endDate: (project.endDate as string | null) ?? null,
              remark: (project.remark as string | null) ?? null,
            }
          : r,
      );
    });
  };

  const confirmArchive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    try {
      await apiFetch(`/api/projects/${archiveTarget.id}`, { method: 'DELETE' });
      toast.success(`已归档「${archiveTarget.name}」`);
      setArchiveTarget(null);
      setListVersion((v) => v + 1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setArchiving(false);
    }
  };

  const restoreProject = async (r: ProjectRow) => {
    try {
      await apiFetch(`/api/projects/${r.id}/unarchive`, { method: 'POST' });
      toast.success(`已恢复「${r.name}」`);
      setListVersion((v) => v + 1);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  // useReactTable 与 React Compiler 记忆化假设不兼容(官方已知,功能正常)。
  const columns = useMemo<ColumnDef<ProjectRow>[]>(() => {
    return [
      {
        accessorKey: 'code',
        header: '项目编号',
        cell: ({ row }) => (
          // 编号属技术标识,用 mono(DESIGN.md code 字体)
          <span className="font-mono text-[13px]">{row.original.code}</span>
        ),
      },
      {
        accessorKey: 'name',
        header: '项目名称',
        cell: ({ row }) => (
          <span className="flex items-center gap-2 font-medium">
            <Link
              href={`/projects/${row.original.id}`}
              className="text-link underline-offset-4 transition-colors hover:text-link-deep hover:underline"
            >
              {row.original.name}
            </Link>
            {row.original.archivedAt ? <Badge variant="secondary">已归档</Badge> : null}
          </span>
        ),
      },
      {
        id: 'members',
        accessorFn: (r) => r.members.map((m) => m.user.name),
        header: ({ column }) => (
          <ValuesHeader column={column} title="负责人" options={memberOptions} />
        ),
        filterFn: membersFilter,
        cell: ({ row }) =>
          row.original.members?.length
            ? row.original.members.map((m) => m.user.name).join('/')
            : '—',
      },
      {
        accessorKey: 'budgetMode',
        header: ({ column }) => (
          <ValuesHeader
            column={column}
            title="预算类型"
            options={['GENERAL', 'LUMP_SUM']}
            valueLabels={{ GENERAL: '一般', LUMP_SUM: '包干制' }}
          />
        ),
        filterFn: valuesStrict,
        cell: ({ row }) =>
          row.original.budgetMode === 'LUMP_SUM' ? (
            <Badge variant="outline">包干制</Badge>
          ) : (
            <Badge variant="secondary">一般</Badge>
          ),
      },
      {
        id: 'projectBudget',
        // 未编制(null)取 undefined:金额区间筛选时被排除(Number(undefined)=NaN 非有限),
        // 排序经 sortUndefined 沉底(basic 比较器遇 NaN 顺序不稳定,codex P2)。
        accessorFn: (r) => (r.projectBudget ? Number(r.projectBudget.currentAmount) : undefined),
        sortUndefined: 'last',
        header: ({ column }) => (
          <HeaderFilter column={column} title="总经费" type="range" sortable />
        ),
        filterFn: numberRange<ProjectRow>(),
        sortingFn: 'basic',
        cell: ({ row }) => (
          <span className="block text-right tabular-nums">
            {(() => {
              // 仅「无 projectBudget」(未编制)留空;编制为 0 也如实渲染 0.00(codex P2)。
              if (!row.original.projectBudget) return '';
              return Number(row.original.projectBudget.currentAmount).toLocaleString('zh-CN', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              });
            })()}
          </span>
        ),
      },
      {
        accessorFn: (r) => r.level ?? '',
        id: 'level',
        header: ({ column }) => (
          <ValuesHeader column={column} title="级别" options={levelOptions} />
        ),
        filterFn: valuesStrict,
        cell: ({ row }) => row.original.level ?? '—',
      },
      {
        accessorFn: (r) => r.projectType ?? '',
        id: 'projectType',
        header: ({ column }) => (
          <ValuesHeader column={column} title="项目类型" options={projectTypeOptions} />
        ),
        filterFn: valuesStrict,
        cell: ({ row }) => (
          <span className="block max-w-28 truncate" title={row.original.projectType ?? undefined}>
            {row.original.projectType || '—'}
          </span>
        ),
      },
      {
        accessorFn: (r) => r.undertakingUnit ?? '',
        id: 'undertakingUnit',
        header: ({ column }) => (
          <ValuesHeader column={column} title="承担单位" options={undertakingUnitOptions} />
        ),
        filterFn: valuesStrict,
        cell: ({ row }) => (
          <span
            className="block max-w-32 truncate"
            title={row.original.undertakingUnit ?? undefined}
          >
            {row.original.undertakingUnit || '—'}
          </span>
        ),
      },
      {
        // 起止时间列:筛选/排序按开始日期,展示保留起~止全区间。
        id: 'startDate',
        accessorFn: (r) => r.startDate ?? undefined,
        sortUndefined: 'last',
        header: ({ column }) => (
          <HeaderFilter column={column} title="起止时间" type="dateRange" sortable />
        ),
        filterFn: dateRange<ProjectRow>(),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatDate(row.original.startDate)} ~ {formatDate(row.original.endDate)}
          </span>
        ),
      },
      {
        accessorFn: (r) => r.remark ?? '',
        id: 'remark',
        header: ({ column }) => <HeaderFilter column={column} title="备注" type="text" />,
        filterFn: textContains<ProjectRow>(),
        cell: ({ row }) => (
          <span className="block max-w-40 truncate" title={row.original.remark ?? undefined}>
            {row.original.remark || '—'}
          </span>
        ),
      },
      {
        accessorKey: 'createdAt',
        header: ({ column }) => (
          <HeaderFilter column={column} title="创建时间" type="dateRange" sortable />
        ),
        filterFn: dateRange<ProjectRow>(),
        sortingFn: 'basic',
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {new Date(row.original.createdAt).toLocaleDateString('zh-CN')}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '操作',
        enableSorting: false,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex flex-wrap gap-1">
              <Button
                variant="link"
                size="sm"
                className="px-0"
                onClick={() => router.push(`/projects/${r.id}`)}
              >
                查看详情
              </Button>
              {r.canEdit && !r.archivedAt ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => openEditDialog(r)}>
                    <Pencil className="size-4" />
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-error-deep hover:bg-error-soft"
                    onClick={() => setArchiveTarget(r)}
                  >
                    <Archive className="size-4" />
                    归档
                  </Button>
                </>
              ) : null}
              {r.canEdit && r.archivedAt ? (
                <Button variant="ghost" size="sm" onClick={() => void restoreProject(r)}>
                  <RotateCcw className="size-4" />
                  恢复
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ];
  }, [router, memberOptions, levelOptions, projectTypeOptions, undertakingUnitOptions]);

  // useReactTable 与 React Compiler 记忆化假设不兼容(官方已知,功能正常)。
  const table = useReactTable({
    data: keywordFiltered,
    columns,
    state: { columnFilters, sorting, columnVisibility },
    onColumnFiltersChange: setColumnFilters,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(), // 客户端筛选(项目量级小,数据全量在内存)
    getSortedRowModel: getSortedRowModel(),
    enableSortingRemoval: true,
    enableMultiSort: false,
  });

  const visibleRows = table.getRowModel().rows;
  const hasHeaderFilter = columnFilters.length > 0;

  return (
    <div className="space-y-6">
      {/* 页头:caption-mono 眉题 + display-md 负字距标题(DESIGN.md) */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="caption-mono">Projects</p>
          <h1 className="text-display-md">项目管理</h1>
        </div>
        {me?.role === 'ADMIN' ? (
          <Button onClick={openCreateDialog}>
            <Plus />
            新建项目
          </Button>
        ) : null}
      </div>

      {/* 工具行:搜索 + 显示已归档开关 + 列设置 */}
      <div className="flex flex-wrap items-center gap-4">
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
        <div className="flex items-center gap-2">
          <Switch id="show-archived" checked={showArchived} onCheckedChange={setShowArchived} />
          <Label htmlFor="show-archived" className="text-sm text-muted-foreground">
            显示已归档
          </Label>
          <ColumnSettingsPopover
            items={[
              { id: 'code', label: '项目编号' },
              { id: 'name', label: '项目名称' },
              { id: 'members', label: '负责人' },
              { id: 'budgetMode', label: '预算类型' },
              { id: 'projectBudget', label: '总经费' },
              { id: 'level', label: '级别' },
              { id: 'projectType', label: '项目类型' },
              { id: 'undertakingUnit', label: '承担单位' },
              { id: 'startDate', label: '起止时间' },
              { id: 'remark', label: '备注' },
              { id: 'createdAt', label: '创建时间' },
            ]}
            columnVisibility={columnVisibility}
            onToggle={toggleColumnVisibility}
          />
        </div>
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
          {me?.role === 'ADMIN' ? (
            <Button onClick={openCreateDialog}>
              <Plus />
              新建项目
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-l2">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((header) => (
                    <TableHead key={header.id} className={HEAD_CLASS[header.column.id]}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {visibleRows.length === 0 ? (
                <TableEmpty colSpan={table.getVisibleLeafColumns().length}>
                  {keyword
                    ? `无匹配「${keyword}」的项目`
                    : hasHeaderFilter
                      ? '无匹配的项目,可调整表头筛选'
                      : '暂无项目'}
                </TableEmpty>
              ) : (
                visibleRows.map((row) => (
                  <TableRow
                    key={row.id}
                    className={row.original.archivedAt ? 'opacity-60' : undefined}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="border-t border-border px-4 py-2 text-xs text-mute tabular-nums">
            共 {visibleRows.length} 个项目
            {showArchived ? '(含已归档)' : ''}
            {hasHeaderFilter ? '(已应用表头筛选)' : ''}
          </div>
        </div>
      )}

      {/* 新建/编辑共用弹窗:react-hook-form + zod;编辑模式编号只读、负责人不展示 */}
      <ProjectFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        me={me}
        userOptions={userOptions}
        onSaved={handleSaved}
      />

      {/* 归档确认:普通确认弹窗(归档可恢复,数据不删除) */}
      <AlertDialog open={!!archiveTarget} onOpenChange={(o) => !o && setArchiveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>归档项目</AlertDialogTitle>
            <AlertDialogDescription>
              确认归档「{archiveTarget?.name}」?归档后项目从列表隐藏,数据完整保留;
              打开「显示已归档」可随时恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiving}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiving}
              onClick={(e) => {
                e.preventDefault();
                void confirmArchive();
              }}
            >
              {archiving ? '归档中…' : '确认归档'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
