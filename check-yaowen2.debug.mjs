import pkg from '@prisma/client';
import DecimalJs from 'decimal.js';
const { PrismaClient } = pkg;
const p = new PrismaClient();
const D = DecimalJs;
const pid = '01a040da-5900-7491-a13e-3ab11e4e3bdd';
const adjs = await p.budgetAdjustment.findMany({ where: { projectId: pid }, include: { lines: true }, orderBy: { createdAt: 'asc' } });
for (const a of adjs) {
  let sumY = new D(0), sumT = new D(0);
  console.log('=== ADJ', a.id, a.kind, 'expandTotals=' + a.expandTotals, 'status=' + a.status, 'year=' + a.year);
  for (const l of a.lines) {
    sumY = sumY.plus(l.annualAdjustment.toString());
    sumT = sumT.plus(l.totalAdjustment.toString());
    console.log('   line', JSON.stringify({ isNew: l.isNewSubject, newName: l.newSubjectName, subjectId: l.subjectId ? l.subjectId.slice(-6) : null, year: l.year, annual: l.annualAdjustment?.toString(), total: l.totalAdjustment?.toString() }));
  }
  console.log('   SUM annualAdj =', sumY.toFixed(2), '| SUM totalAdj =', sumT.toFixed(2));
}
const audits = await p.auditLog.findMany({ where: { projectId: pid }, orderBy: { createdAt: 'asc' } });
console.log('\n######## AUDIT TIMELINE ########');
for (const au of audits) {
  console.log(`${au.createdAt.toISOString()} [${au.objectType}] ${au.action}`);
  if (['project_budgets','annual_budgets','subject_budgets','subject_total_budgets'].includes(au.objectType)) {
    console.log('   before:', au.before == null ? null : JSON.stringify(au.before).slice(0, 300));
    console.log('   after :', au.after == null ? null : JSON.stringify(au.after).slice(0, 300));
  }
}
await p.$disconnect();
