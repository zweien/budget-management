import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const p = new PrismaClient();
const pid = '01a040da-5900-7491-a13e-3ab11e4e3bdd';
const audits = await p.auditLog.findMany({ where: { projectId: pid }, orderBy: { operatedAt: 'asc' } });
for (const au of audits) {
  console.log(`${au.operatedAt.toISOString()} [${au.objectType}] ${au.action}`);
  const keys = ['initialAmount','adjustmentAmount','currentAmount','amount','status'];
  const pick = (o) => { if (!o || typeof o !== 'object') return o; const out = {}; for (const k of keys) if (k in o) out[k] = o[k]; return Object.keys(out).length ? out : undefined; };
  const b = au.beforeData ?? au.before;
  const a = au.afterData ?? au.after;
  console.log('   before:', b == null ? null : JSON.stringify(pick(typeof b === 'string' ? JSON.parse(b) : b)));
  console.log('   after :', a == null ? null : JSON.stringify(pick(typeof a === 'string' ? JSON.parse(a) : a)));
}
await p.$disconnect();
