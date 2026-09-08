---
name: budget-ops
description: 通过 API 操作科研项目预算管理系统(查询/统计、初始预算编制、预算调整、结算单导入、业务记录维护、到账登记)。内置三档确认策略与无人值守收件箱流程;任意 coding agent 会话可用,不依赖 MCP。
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

- **401**:凭证无效/已撤销/已过期 → 停止并上报,请用户在「API 凭证」页重发(服务账号场景 `npm run make-agent` 重发)。
- **403 且消息含「无人值守凭证禁止」**:命中硬排除(见下),**不得**尝试绕过,原样上报。
- **403 且消息含「凭证档位」「凭证未授权访问该项目」或「禁止…跨项目操作」**:key 的范围收窄(档位/项目范围),同样**不得**绕过;原样上报,或请用户换范围更大的 key。指定项目范围的 key:统计/审计等聚合接口必须携带已授权的 `projectId`,项目列表也只含授权项目。
- **403 且消息含「仅项目负责人」或「成员」**:不是凭证范围问题,是服务账号本身没有该项目成员身份——编制/调整/科目维护等 OWNER 动作要求 ADMIN 或项目 OWNER 成员(HANDLER 不行);请管理员在项目「成员管理」把服务账号以 **OWNER** 加入,或换管理员凭证。
- **422**:业务校验失败,按消息修正后可重试。
- **排查 403 先查本凭证元数据(仅适用全范围 key)**:Bearer 不能访问 `/api/api-keys*`(红线);**指定项目范围(selected)的 key 此路不通**——无 projectId 的 `GET /audit-logs` 属跨项目接口会被拒,带 projectId 也查不到签发记录(`apikey.issue` 审计行的 projectId 为空)。全范围(all)key:`GET /audit-logs?limit=50` 找 `action=apikey.issue` 且 `afterData.prefix` 匹配本 key 前缀的记录,可得档位(tier)/项目范围(projectScope)/无人值守(unattended)/有效期(expiresAt);selected-scope 场景请用户在「API 凭证」页查看或问管理员。

## 2. 确认策略(必须遵守)

| 档位         | 操作                                                                                                   | 规则                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **自主**     | 查询、统计、审计、文件解析、导入预览、暂存、科目指派                                                   | 随时可做                                                                                     |
| **指令授权** | 新增/修改业务记录、**确认导入**、到账登记、项目创建、初始预算编制与预算调整(建/改/提交;均须「完整」档) | 仅当本次任务指令明确列出该动作(宜点名对象)才做;指令没说就不做,先汇报待授权                   |
| **硬排除**   | 作废、审批(通过/驳回)、成员/权限变更、凭证管理                                                         | 永不执行;无人值守凭证服务端强制 403。人在场且用户明确要求时,提示用户在 UI 操作或改用在场凭证 |

## 3. 操作目录

`$PID` = 项目 ID。路径前省略 `$BASE/api`。

### 自主

| 操作               | 调用                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目列表           | `GET /projects?includeArchived=1`                                                                                                                                            |
| 项目详情           | `GET /projects/$PID`                                                                                                                                                         |
| 执行台账           | `GET /projects/$PID/ledger?year=2026`                                                                                                                                        |
| 总预算台账(跨年度) | `GET /projects/$PID/ledger-total` — 占用/结余/执行率按科目总预算(包干制 = Σ年度)对全部年度记录计算                                                                           |
| 业务记录列表       | `GET /projects/$PID/records?year=&subjectId=&status=&includeVoid=1&handler=&summary=&businessDateFrom=&businessDateTo=`(status ∈ PLACEHOLDER/CONTRACT/FINANCE_APPROVAL/PAID) |
| 记录变更历史       | `GET /projects/$PID/records/:recordId/history`                                                                                                                               |
| 导入批次列表       | `GET /projects/$PID/imports`(最近 20 条)                                                                                                                                     |
| 导入批次预览       | `GET /projects/$PID/imports/:batchId`                                                                                                                                        |
| **科目映射记忆**   | `GET /projects/$PID/subject-mappings?q=&limit=` → `{summary, subjectId, subjectCode, subjectName, useCount}`                                                                 |
| 月度统计           | `GET /statistics/monthly?projectId=$PID&year=2026`                                                                                                                           |
| 余额统计           | `GET /statistics/balance?subject=&projectId=&year=&onlyNegative=1`                                                                                                           |
| 审计日志           | `GET /audit-logs?projectId=&action=&dateFrom=&dateTo=&limit=`(无人值守被拒尝试 action=`unattended.denied`)                                                                   |
| 编制单回读         | `GET /projects/$PID/initial-budget` — 初始预算编制单全量(状态/科目树/年度/明细/总预算);**404 = 有权限且该项目尚未编制**,可作「完整档 + OWNER」权限的只读探测                 |
| 调整单列表         | `GET /projects/$PID/adjustments` — 全部调整单(状态/kind/明细/锁),响应 `{adjustments:[…]}`;`GET …/adjustments/:adjId` 取单张,响应 `{adjustment:{…}}`                          |
| 上传解析(不改台账) | `POST -F file=@文件.xlsx /projects/$PID/imports` → `{batchId}`,格式自动识别(结算单 v1 填制日期版 / v2 申请日期版 / 标准模板)                                                 |
| 补全更新预览       | 结算单再次导入命中同单据编号且金额一致、带来新信息(补完成日期/状态推进到已支出)→ 行标「补全更新」,确认后**更新**既有记录(非新增);金额不一致或无新信息 = 硬重复,禁止          |
| 暂存行修改         | `PATCH /projects/$PID/imports/:batchId`,body `{"updates":[{"rowId","subjectId"?,"budgetYear"?,"forcedImport"?}]}`                                                            |

### 指令授权

| 操作         | 调用                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **确认导入** | `POST /projects/$PID/imports/:batchId/confirm`(须全部行已指派叶科目且无阻断错误;返回 422 时按消息处理)                                                                                                                         |
| 新增记录     | `POST /projects/$PID/records`,body `{budgetYear, subjectId, amount:"1234.56", businessDate:"yyyy-mm-dd", handler, summary, status, docNo?, remark?}`                                                                           |
| 修改记录     | `PATCH /projects/$PID/records/:recordId`(字段全部可选)                                                                                                                                                                         |
| 到账登记     | `POST /projects/$PID/receipts`,body `{receiptDate, amount:"…", summary?, remark?}`                                                                                                                                             |
| 项目创建     | `POST /projects`,body `{code, name, ownerId?, budgetMode?("GENERAL"/"LUMP_SUM"), startDate?, endDate?(YYYY-MM-DD)}`;仅管理员;ownerId 缺省=自己,**owner 自动加为 OWNER 成员**;code 系统内唯一(冲突 409),惯例「负责人拼音+序号」 |
| 创建编制单   | `POST /projects/$PID/initial-budget` → 201 `{appId}`;一个项目仅一份编制(重复 409;归档项目 409),payload 见下                                                                                                                    |
| 修改编制单   | `PATCH /projects/$PID/initial-budget/:appId`(同 payload 全量;**DRAFT/REJECTED/WITHDRAWN 可改,改后回到 DRAFT**;服务端**删旧重建科目树,科目 id 会变**——改完后旧的 subjectId 全部作废,须重新拉取)                                 |
| 提交审批     | `POST /projects/$PID/initial-budget/:appId/submit`(无人值守可提交;**审批通过/驳回属硬排除**,需管理员在 UI 操作,通过后 current 预算才置位生效)                                                                                  |
| 创建调整单   | `POST /projects/$PID/adjustments`,body `{year, kind?, annualReason?, totalReason?, expandTotals?, lines:[{subjectId, totalAdjustment, annualAdjustment}]}` → 201 含 id(subjectId 取 `GET /subjects` 叶科目)                    |
| 修改调整单   | `PATCH /projects/$PID/adjustments/:adjId`(全量 payload;**DRAFT/REJECTED 可改**,驳回单改后可重新提交)                                                                                                                           |
| 删除调整单   | `DELETE /projects/$PID/adjustments/:adjId`(仅 DRAFT 可删;REJECTED 单要弃用就走改单重提)                                                                                                                                        |
| 提交调整单   | `POST /projects/$PID/adjustments/:adjId/submit`(DRAFT→PENDING,调减行校验可调额度并写锁)                                                                                                                                        |
| 撤回调整单   | `POST /projects/$PID/adjustments/:adjId/withdraw`(PENDING→DRAFT 并释放锁;审批前修正用)                                                                                                                                         |

科目树接口 `GET /projects/$PID/subjects` 可取叶科目(响应为 `{subjects:[…]}`;指派科目与调整单明细引用科目一律用 **subjectId**,不是 code)。

> **预算类型口径**:项目详情的 `budgetMode` 有两值——`GENERAL`(一般,默认)与 `LUMP_SUM`(包干制)。包干制项目**没有科目总预算**(台账 `totalCurrent` 与余额统计 `totalBudget` 已自动回退为该科目各年度预算之和),也**不支持总维度调整**(调整单 totalAdjustment 恒 0);查询/汇报科目结余直接用上述回退口径即可。

**初始预算编制 payload**(创建/修改同构,金额一律 decimal 字符串):

```json
{
  "projectTotal": "3200000.00",
  "annualBudgets": [{ "year": 2026, "amount": "1920000.00" }],
  "subjects": [
    { "code": "1", "name": "直接费用", "parentCode": null, "isLeaf": false },
    { "code": "1.2", "name": "材料费", "parentCode": "1", "isLeaf": false },
    { "code": "1.2.1", "name": "高性能计算资源配件", "parentCode": "1.2", "isLeaf": true }
  ],
  "subjectBudgets": [
    { "year": 2026, "subjectCode": "1.2.1", "unit": "项", "quantity": "1", "unitPrice": "153600" }
  ],
  "subjectTotalBudgets": [{ "subjectCode": "1.2.1", "amount": "153600.00" }]
}
```

实测要点与坑:

- **金额 = 服务端按 `quantity × unitPrice` 重算,payload 里的 `amount` 被忽略**;每条分配的 `unit/quantity/unitPrice` 三项必填(unit 非空,数量/单价 ≥ 0)。来源表格「数量×单价 ≠ 总计」时以「总计」列为准反推数量/单价,拿不准先问用户。
- 422 校验:金额只能填叶科目;Σ年度 ≤ 项目总预算(**允许少**——总预算未分配到年度的余额合法,如 320 万只声明 2026 年 192 万);同年度叶分配合计 ≤ 该年度预算;各叶科目 Σ年度分配 ≤ 其总预算、Σ总预算 ≤ 项目总预算(仅 GENERAL 模式;包干制忽略 subjectTotalBudgets);科目编码项目内唯一、parentCode 必须存在、不得成环。
- 服务端不存父级科目金额(由叶科目汇出);来源表格「明细行合计 ≠ 父级合计」几乎总意味着某行录错,且会撞上上述 ≤ 校验——**先核算再创建,对不上向用户确认**。
- 科目命名/编码「与前期保持一致」:`GET /projects/<前期PID>/initial-budget` 取已审批编制单的科目树作参照;名称逐字复用,表内括号备注(如「(1/3)」)是阶段标注不是名称,不要带进科目名。
- 未给计量单位/数量的行,惯例按「项 / 数量 1 / 单价=金额」补齐(零预算行 0×0),并在汇报中注明所做约定。

**预算调整要点**(kind 二选一;金额一律 decimal 字符串;均须「完整」档 + OWNER):

- `ADJUST`(调剂,缺省):零和挪钱——`totalAdjustment` 与 `annualAdjustment` **各自 Σ=0**;包干制 totalAdjustment 恒 0(只填年度维度)。
- `ALLOCATE`(追加下达):每行 `annualAdjustment` ≥ 0 且 Σ>0、totalAdjustment=0;`expandTotals:true`=新经费入账(项目总预算同步调增),缺省 false=余额内向年度追加计划(受项目剩余额度护栏约束)。**项目从无年度预算到首次下达走 ALLOCATE,不要用 ADJUST 硬凑**(调剂的年度维度必须零和)。容量护栏双向:项目层「年度计划 ≤ 项目剩余额度」、GENERAL 科目层「各科目本年计划 ≤ 科目总预算」;零值科目直接省略,不建零额行。
- **「调整到 X」必须先折算**:Δ = X − 当前科目预算。基线一律取**当前生效预算**——`GET /projects/$PID/adjustments/balance?year=Y`(调整表单余额面板)或余额统计的 `yearBudget`;已审批编制单只在项目从未批过调整时才等于当前值(`getDraft` 返回 initial 口径,批过调整后拿它折算必错)。多目标先核 ΣΔ 再动手——零和 → 一张 ADJUST;净增 → ALLOCATE(必要时再配一张 ADJUST 摆匀各科目);**年度总额没有净调减通道**(ADJUST 零和、ALLOCATE 只增)。目标值不自洽时把折算表摆给用户确认,不要自行挑数凑平(实测:用户报三个「调整到」目标隐含净增 1 万,与其原口径矛盾,追问后改口为一个目标值,净额归零)。
- 调减行提交时校验可调额度(= 科目年度预算 − 已占用)并写预算锁;在途 PENDING 单同样占额度。
- 提交响应体不保证字段完整,以 `GET /adjustments` 回读状态(DRAFT→PENDING)为准;调整在管理员审批通过后才生效。

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
