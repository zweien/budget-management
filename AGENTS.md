# AGENTS.md

面向编码代理（与人类协作者）的仓库工作约定。环境类注意事项另见 [CLAUDE.md](./CLAUDE.md)。

## 项目速览

科研项目预算管理系统：Next.js 16(App Router)+ React 19 + Prisma + PostgreSQL,前端 shadcn/ui + Tailwind CSS 4(DESIGN.md token 体系)。常用命令:`npm run dev` / `npm test` / `npm run check-types` / `npm run lint` / `npm run build`。

## 版本发布流程(确保版本号唯一)

**唯一事实源:`package.json` 的 `version` 字段;git tag `vX.Y.Z` 与其一一对应。**
侧边栏版本号与 `/changelog` 页自动跟随,无需手改前端。

### 何时 bump(conventional commits ↔ semver)

| 变更类型                          | bump      |
| --------------------------------- | --------- |
| `fix`(缺陷修复)                   | **patch** |
| `feat`(新功能,向后兼容)           | **minor** |
| 破坏性变更(`BREAKING CHANGE`/`!`) | **major** |

### 发布步骤(在 `main` 上执行)

```bash
# 1. 确认工作区干净、main 与远端同步
git status && git pull

# 2. 更新 CHANGELOG.md:为即将发布的版本新增一节
#    ## [X.Y.Z] - YYYY-MM-DD(新增/变更/修复)

# 3. 唯一性预检:目标 tag 不得已存在
git fetch --tags
git tag -l "vX.Y.Z"   # 有输出 = 已被占用,换版本号

# 4. npm version 自动:bump package.json + 提交 + 打 tag
npm version patch   # 或 minor / major

# 5. 推送提交与 tag
git push --follow-tags
```

### 硬性规则

- **禁止手改 `package.json` 的 `version`**——必须经过 `npm version`,否则没有对应 git tag,唯一性无从校验。
- **禁止跳过 CHANGELOG.md**——每个版本节先于 `npm version` 提交;`/changelog` 页直接渲染它,漏写即漏公示。
- **tag 即唯一锁**:`npm version` 生成的 `vX.Y.Z` tag 若已存在,第 5 步推送会被远端拒绝,此时说明版本号撞车,换号重来;不要强推覆盖 tag。
- 功能分支上不执行 `npm version`;合并入 `main` 后才发版,保证 tag 指向主干历史。
- 预发布用 `npm version prepatch --preid=beta`(产出 `vX.Y.Z-beta.0`),不占正式号段。
