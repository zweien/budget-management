import pkg from '@prisma/client';
const { PrismaClient } = pkg;
const p = new PrismaClient();
const rows = await p.$queryRawUnsafe(`select p.name, pb.initial_amount, pb.adjustment_amount, pb.current_amount from project_budgets pb join projects p on p.id = pb.project_id order by p.name`);
for (const r of rows) console.log(r.name.slice(0,20).padEnd(22), 'PB init=' + String(r.initial_amount).padStart(9), 'adj=' + String(r.adjustment_amount).padStart(9), 'cur=' + String(r.current_amount).padStart(9));
const abrows = await p.$queryRawUnsafe(`select p.name, ab.year, ab.initial_amount, ab.adjustment_amount, ab.current_amount from annual_budgets ab join projects p on p.id = ab.project_id order by p.name, ab.year`);
console.log('\n--- annual ---');
for (const r of abrows) console.log(r.name.slice(0,20).padEnd(22), r.year, 'AB init=' + String(r.initial_amount).padStart(9), 'adj=' + String(r.adjustment_amount).padStart(9), 'cur=' + String(r.current_amount).padStart(9));
await p.$disconnect();
