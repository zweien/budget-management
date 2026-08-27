import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const projects = await p.project.findMany({ where: { name: { contains: '姚雯' } }, select: { id: true, name: true } });
console.log(JSON.stringify(projects, null, 2));
for (const proj of projects) {
  const pb = await p.projectBudget.findUnique({ where: { projectId: proj.id } });
  console.log('ProjectBudget:', JSON.stringify(pb));
  const abs = await p.annualBudget.findMany({ where: { projectId: proj.id } });
  console.log('AnnualBudgets:', JSON.stringify(abs));
  const adjs = await p.budgetAdjustment.findMany({ where: { projectId: proj.id }, include: { lines: true } });
  console.log('Adjustments:', adjs.map(a => ({ id: a.id, kind: a.kind, status: a.status, expandTotals: a.expandTotals, year: a.year, approvedAt: a.approvedAt, lines: a.lines.map(l => ({ subjectId: l.subjectId, year: l.year, annual: l.annualAdjustment?.toString(), total: l.totalAdjustment?.toString() })) })));
}
await p.$disconnect();
