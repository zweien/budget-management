# 机器认证采用服务账号 + 静态 API Key

coding agent 需要无人值守地操作预算系统(定时导入结算单、维护记录等),而系统原有认证只有人类会话(Authentik OIDC cookie / mock header)。我们决定:为 agent 建真实 `User` 服务账号(与人类同受角色与项目成员权限矩阵约束),认证用静态 API Key(`bma_` 前缀,SHA-256 入库、仅创建时展示一次、可撤销,`Authorization: Bearer`);`unattended` 凭证在服务端直接拒绝硬排除动作(作废/审批/成员管理,见 `permissions.ts`)。

## Considered Options

- **长效 JWT**:无人值守要处理过期与刷新,复杂度白付;静态 key 可即时撤销,更适合机器。
- **agent 模拟浏览器走 SSO**:脆弱,依赖 Authentik 页面流程不变。
- **策略仅文档约束(不做服务端拦截)**:被提示词注入或失控的 agent 仍能执行不可逆操作;拦截成本极低而收益是系统级兜底。

## Consequences

- 服务账号的权限收放完全复用现有成员管理(移出 OWNER 即收权),零新权限代码。
- 在场交互若需执行硬排除动作,使用 `make-agent --attended` 签发的凭证(不带 `unattended` 标记)。
- key 泄露的影响范围 = 该服务账号的项目授权;撤销后 agent 立即 401。
