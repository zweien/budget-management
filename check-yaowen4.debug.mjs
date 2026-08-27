import pkg from '@prisma/client';
import DecimalJs from 'decimal.js';
const { PrismaClient } = pkg;
const p = new PrismaClient();
const D = DecimalJs;
const pid = '01a040da-5900-7491-a13e-3ab11e4e3bdd';

const sb = await p.subjectBudget.findMany({ where: { projectId: pid }, include: { subject: true }, orderBy: [{ year: 'asc' }] });
console.log('== subject_budgets ==');
let sumInitial = new D(0), sumCur = new D(0);
for (const r of sb) {
  sumInitial = sumInitial.plus(r.initialAmount.toString());
  sumCur = sumCur.plus(r.currentAmount.toString());
  console.log(r.year, r.subject.code, r.subject.name, 'init=' + r.initialAmount, 'adj=' + r.adjustmentAmount, 'cur=' + r.currentAmount);
}
console.log('SB SUM init=' + sumInitial.toFixed(2), 'cur=' + sumCur.toFixed(2));

const stb = await p.subjectTotalBudget.findMany({ where: { projectId: pid }, include: { subject: true } });
console.log('\n== subject_total_budgets ==');
let sI = new D(0), sC = new D(0);
for (const r of stb) {
  sI = sI.plus(r.initialAmount.toString()); sC = sC.plus(r.currentAmount.toString());
  console.log(r.subject.code, r.subject.name, 'init=' + r.initialAmount, 'adj=' + r.adjustmentAmount, 'cur=' + r.currentAmount);
}
console.log('STB SUM init=' + sI.toFixed(2), 'cur=' + sC.toFixed(2));

const pb = await p.projectBudget.findUnique({ where: { projectId: pid } });
console.log('\nproject_budget:', JSON.stringify(pb));
const ab = await p.annualBudget.findMany({ where: { projectId: pid } });
console.log('annual_budgets:', JSON.stringify(ab));
await p.$disconnect();
