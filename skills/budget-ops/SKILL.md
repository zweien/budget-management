---
name: budget-ops
description: 通过 API 操作科研项目预算管理系统(查询/统计、结算单导入、业务记录维护、到账登记)。内置三档确认策略与无人值守收件箱流程;任意 coding agent 会话可用,不依赖 MCP。
---

# 预算系统操作(budget-ops)

通过 HTTP API 以**服务账号**身份操作科研项目预算管理系统。若当前会话已接入 `budget_*` MCP 工具,优先用工具;否则按本文用 `curl`。

## 1. 配置

凭据在 `~/.budget-agent.json`(chmod 600),由管理员运行 `npm run make-agent` 生成:

```json
{ "baseUrl": "http://localhost:3000", "token": "bma_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
```

环境变量 `BUDGET_BASE_URL` / `BUDGET_TOKEN` 可覆盖。所有请求带 `Authorization: Bearer <token>`:

```bash
BASE=$(jq -r .baseUrl ~/.budget-agent.json); TOK=$(jq -r .token ~/.budget-agent.json)
curl -sS -H "Authorization: Bearer $TOK" "$BASE/api/projects"
```

- **401**:凭证无效/已撤销 → 停止并上报,请管理员 `npm run make-agent` 重发。
- **403 且消息含「无人值守凭证禁止」**:命中硬排除(见下),**不得**尝试绕过,原样上报。
- **422**:业务校验失败,按消息修正后可重试。

## 2. 确认策略(必须遵守)

| 档位         | 操作                                                          | 规则                                                                                         |
| ------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **自主**     | 查询、统计、审计、文件解析、导入预览、暂存、科目指派          | 随时可做                                                                                     |
| **指令授权** | 新增/修改业务记录、**确认导入**、到账登记、预算调整编制与提交 | 仅当本次任务指令明确列出该动作(宜点名对象)才做;指令没说就不做,先汇报待授权                   |
| **硬排除**   | 作废、审批(通过/驳回)、成员/权限变更、凭证管理                | 永不执行;无人值守凭证服务端强制 403。人在场且用户明确要求时,提示用户在 UI 操作或改用在场凭证 |

## 3. 操作目录

`$PID` = 项目 ID。路径前省略 `$BASE/api`。

### 自主

| 操作               | 调用                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目列表           | `GET /projects?includeArchived=1`                                                                                                                                            |
| 项目详情           | `GET /projects/$PID`                                                                                                                                                         |
| 执行台账           | `GET /projects/$PID/ledger?year=2026`                                                                                                                                        |
| 业务记录列表       | `GET /projects/$PID/records?year=&subjectId=&status=&includeVoid=1&handler=&summary=&businessDateFrom=&businessDateTo=`(status ∈ PLACEHOLDER/CONTRACT/FINANCE_APPROVAL/PAID) |
| 记录变更历史       | `GET /projects/$PID/records/:recordId/history`                                                                                                                               |
| 导入批次列表       | `GET /projects/$PID/imports`(最近 20 条)                                                                                                                                     |
| 导入批次预览       | `GET /projects/$PID/imports/:batchId`                                                                                                                                        |
| **科目映射记忆**   | `GET /projects/$PID/subject-mappings?q=&limit=` → `{summary, subjectId, subjectCode, subjectName, useCount}`                                                                 |
| 月度统计           | `GET /statistics/monthly?projectId=$PID&year=2026`                                                                                                                           |
| 余额统计           | `GET /statistics/balance?subject=&projectId=&year=&onlyNegative=1`                                                                                                           |
| 审计日志           | `GET /audit-logs?projectId=&action=&dateFrom=&dateTo=&limit=`(无人值守被拒尝试 action=`unattended.denied`)                                                                   |
| 上传解析(不改台账) | `POST -F file=@文件.xlsx /projects/$PID/imports` → `{batchId}`,格式自动识别(结算单/标准模板)                                                                                 |
| 暂存行修改         | `PATCH /projects/$PID/imports/:batchId`,body `{"updates":[{"rowId","subjectId"?,"budgetYear"?,"forcedImport"?}]}`                                                            |

### 指令授权

| 操作         | 调用                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **确认导入** | `POST /projects/$PID/imports/:batchId/confirm`(须全部行已指派叶科目且无阻断错误;返回 422 时按消息处理)                                               |
| 新增记录     | `POST /projects/$PID/records`,body `{budgetYear, subjectId, amount:"1234.56", businessDate:"yyyy-mm-dd", handler, summary, status, docNo?, remark?}` |
| 修改记录     | `PATCH /projects/$PID/records/:recordId`(字段全部可选)                                                                                               |
| 到账登记     | `POST /projects/$PID/receipts`,body `{receiptDate, amount:"…", summary?, remark?}`                                                                   |

科目树接口 `GET /projects/$PID/subjects` 可取叶科目(指派科目时 subjectId 必须是叶科目)。

## 4. 无人值守:结算单收件箱流程

定时任务提示词通常是「扫描收件箱并处理」。流程:

1. 扫描 `~/budget-inbox/<项目编号>/*.xlsx`;目录名即项目编号,用项目列表把编号换成 `$PID`。
2. 逐文件:上传解析 → `budget_get_import_preview` 查看行/错误/重复。
3. **科目自动指派**:先查科目映射记忆(整表一次 + 未命中摘要按词补查);命中 → 直接指派;未命中 → 对着科目树语义判断(拿不准就留空);仍不确定的行留空并计入待指派清单。
4. `PATCH` 暂存全部可确定的行。**确认导入仅当任务指令明确授权时执行**;否则批次留在暂存,汇报里列出待确认批次与待指派行。
5. 成功 → 文件移入 `~/budget-inbox/<项目编号>/_done/`;上传或解析失败 → 移入 `_failed/`,旁边写 `<同名>.txt` 说明原因。

## 5. 汇报格式(无人值守任务收尾必出)

```
✅ 成功:<文件名> → <项目名> N 条(M 主科目明细/金额合计)
⏸️ 暂存:<文件名> → 批次 <batchId>,待指派 K 行(摘要列表)、待确认
❌ 失败:<文件名> → 原因(已移入 _failed/)
🚫 被拒:命中硬排除的动作与原因(如有)
```

只报结果与数字,不贴原始 JSON。
