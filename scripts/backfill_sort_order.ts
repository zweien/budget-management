// 一次性修复:为历史 budget_subjects 回填 sort_order(层级先序,sibling 按模板顺序)。
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// PRD 附录 A 模板的 code → 展示位置。
const TEMPLATE_ORDER: Record<string, number> = {
  ZJF: 0,
  SBF: 1,
  SBGZF: 2,
  QTSBF: 3,
  CLF: 4,
  WBXZF: 5,
  RLDLF: 6,
  HYCLF: 7,
  HYF: 8,
  CLF2: 9,
  GJHZ: 10,
  CBWX: 11,
  LWF: 12,
  ZJZX: 13,
  QTZC: 14,
  JJF: 15,
  KYJX: 16,
  GLF: 17,
};
const OFF_TEMPLATE = 1000; // 模板外科目的基准位次,避免与模板冲突。

function siblingRank(code: string): number {
  return code in TEMPLATE_ORDER ? TEMPLATE_ORDER[code] : OFF_TEMPLATE;
}

async function backfillProject(projectId: string) {
  const subjects = await prisma.budgetSubject.findMany({ where: { projectId } });
  if (subjects.length === 0) return 0;

  const byId = new Map(subjects.map((s) => [s.id, s]));
  // parentId(null) → 根;否则父 id。
  const childrenOf = new Map<string | null, typeof subjects>();
  for (const s of subjects) {
    const key = s.parentId ?? null;
    const arr = childrenOf.get(key) ?? [];
    arr.push(s);
    childrenOf.set(key, arr);
  }
  // sibling 排序:模板 code 优先,再按 level、再按 code 稳定兜底。
  const sortSiblings = (arr: typeof subjects) =>
    [...arr].sort((a, b) => {
      const ta = siblingRank(a.code),
        tb = siblingRank(b.code);
      if (ta !== tb) return ta - tb;
      if (a.level !== b.level) return a.level - b.level;
      return a.code.localeCompare(b.code);
    });

  // 层级先序遍历,分配连续 sort_order。
  let counter = 0;
  const order: { id: string; sortOrder: number }[] = [];
  const roots = sortSiblings(childrenOf.get(null) ?? []);
  const visit = (node: (typeof subjects)[number]) => {
    order.push({ id: node.id, sortOrder: counter++ });
    const kids = sortSiblings(childrenOf.get(node.id) ?? []);
    for (const k of kids) visit(k);
  };
  for (const r of roots) visit(r);

  // 批量更新。
  for (const o of order) {
    await prisma.budgetSubject.update({ where: { id: o.id }, data: { sortOrder: o.sortOrder } });
  }
  return order.length;
}

async function main() {
  const projects = await prisma.project.findMany({ select: { id: true, code: true } });
  console.log(`回填 ${projects.length} 个项目的科目顺序…`);
  let total = 0;
  for (const p of projects) {
    const n = await backfillProject(p.id);
    if (n > 0) console.log(`  ${p.code} (${p.id}): ${n} 科目`);
    total += n;
  }
  console.log(`完成,共回填 ${total} 条。`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
