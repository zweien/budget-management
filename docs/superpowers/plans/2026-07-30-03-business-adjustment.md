# 业务与调整层(Business & Adjustment)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 实现业务记录管理(§8)、预算调整(§7,含额度锁定与审批生效事务)、科目变更单(§5.3)、审批中心。跑通"占用→调整→审批"闭环。

**Architecture:** Service 层封装规则;业务记录修改联动重算(§8.5);调整提交写 budget_locks、生效走 §7.6 七步事务;复用 core 层的 ledger 公式。

**Tech Stack:** Prisma 事务、decimal.js、复用 lib/budget 公式 + lib/auth + audit。

## Global Constraints(继承)

- 金额 Decimal(18,2) + decimal.js + 字符串传输;主键 UUID v7;审计 `recordAudit(tx,...)` 同事务。
- 业务记录占用实时聚合(不存表);修改/作废后占用自然重算。
- 预算调整锁定落在调出叶节点科目(budget_locks);生效原子(§7.6)。
- 服务端权限再校验(§15.3)。

---

## Task 1: businessRecord.service.ts(§8) + API

**Files:** `src/server/services/businessRecord.service.ts`, `src/app/api/.../records/route.ts`, `[recordId]/route.ts`

**Functions:**

- `createRecord(projectId, input, user)`: requirePermission('record:create'); 校验 subjectId 是该项目叶节点 + budgetYear 有效;超预算允许(§8.4)但返回预警标志;审计 create。
- `listRecords(projectId, {year, subjectId, status, includeVoid}, user)`: 权限 + 组合筛选。
- `updateRecord(recordId, input, user)`: §8.5 修改——金额/年度/科目/状态/日期改后,占用自动重算(因为是实时聚合,无需手动重算;但校验新年度/新科目有效)。修改前后留痕(business_record_history + audit)。
- `voidRecord(recordId, reason, user)`: §8.6 作废——isVoid=true,记 voidReason/voidedBy/voidedAt;占用自动解除(实时聚合);审计。不得物理删除。
- `switchStatus(recordId, newStatus, user)`: §8.3 四态自由切换;记 history;审计。

**Routes:** `/api/projects/[id]/records` GET/POST; `/api/projects/[id]/records/[recordId]` PATCH(void + update).

**Tests:** create 成功 + 超预算返回预警但保存; void 后 ledger 占用=0(验证 §8.6 实时解除); update 改科目后新科目占用增加; status 切换留痕。

## Task 2: 业务记录页面

**Files:** `src/app/(dashboard)/projects/[id]/records/page.tsx`(列表 + 新增/作废), 复用 MoneyText。

- 列表 AntD Table(项目/年度/科目/金额/状态/经办人/摘要/操作);筛选(年度/科目/状态/是否作废)。
- 新增表单(选年度+叶科目+金额+日期+经办人+摘要+状态);超预算时确认弹窗(§8.4)。
- 作废操作(二次确认 + 原因)。

**Verify:** build + check-types + lint。

## Task 3: adjustment.service.ts(§7 草稿+提交+锁定)

**Files:** `src/server/services/adjustment.service.ts`, `/api/.../adjustments/route.ts`, `[adjId]/submit/route.ts`

**Functions:**

- `createAdjustment(projectId, payload, user)`: payload 含 type(PROJECT_TOTAL/ANNUAL/SUBJECT/SUBJECT_TRANSFER)、lines[{levelType, year?, subjectId?, direction, amount}]、reason。校验基础。
- `submitAdjustment(adjId, user)`: §7.4/7.5——对每个调出(DIRECTION=DECREASE)叶节点写 budget_locks(amount=调出额);校验调出额 ≤ 科目可调额度(adjustableAmount)。提交后状态 DRAFT→PENDING。审计。
- 调入不锁(§7.5)。

**Tests:** create+submit 成功写 locks;调出超可调额度→422;调剂两端金额平衡校验。

## Task 4: adjustment 审批生效(§7.6 七步事务)

**Files:** adjustment.service.ts(approve/reject/withdraw), `/api/.../adjustments/[adjId]/{approve,reject}/route.ts`

**Functions:**

- `approveAdjustment(adjId, user, opinion)`: §7.6 事务内:①重新校验约束 ②重新校验调出可调额度(可能因新业务占用而不足→拒) ③写调整明细 ④更新 current_amount(项目/年度/叶节点) ⑤释放 locks(releasedAt) ⑥重算汇总(实时聚合,无需手动) ⑦审计。
- 额度不足→409/422 不得通过。
- reject/withdraw 释放锁。

**Tests:** approve 成功(current 增减正确 + locks 释放); 审批时额度因新业务不足→拒; 调剂两端金额平衡生效。

## Task 5: 科目变更单(§5.3) + 审批中心

**Files:** `subjectChange.service.ts`, `/api/.../subject-changes/...`, `src/app/(dashboard)/approvals/page.tsx`

- `createSubjectChange(projectId, payload, user)`: §5.4 结构保护——已有数据科目不得删除/移动/改 leaf 属性(校验);only 改名/编码/说明或新增未用科目。before/after snapshot。
- 审批生效应用结构变更。
- 审批中心页:聚合 initial_budget/adjustment/subject_change 待办列表 + 审批操作。

**Tests:** 结构保护校验(有数据科目删→拒);审批生效;审批中心聚合三种待办。

## Task 6: 层验收

- 全量 npm test;playwright 冒烟:建业务记录(超预算预警)→ 发起调整 → 审批 → 台账 current 变化。
- 更新 ledger,merge。

## DoD

- 业务记录四态 + 作废 + 超预算预警全通,占用实时正确。
- 调整锁定+生效事务正确(§7.4/7.5/7.6)。
- 科目变更结构保护生效。
- 审批中心聚合三种待办。
