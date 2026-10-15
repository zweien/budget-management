# IDRL VI 接入记录

本应用 UI 已按 [zweien/idrl-vi](https://github.com/zweien/idrl-vi) 视觉识别体系重构。
本文记录来源、复制范围、本地适配与验证方式;品牌数值以 idrl-vi 的
`assets/brand/tokens.json` 为唯一来源,不在本仓库私改。

## 来源

| 项             | 值                                                                               |
| -------------- | -------------------------------------------------------------------------------- |
| 源仓库         | https://github.com/zweien/idrl-vi                                                |
| sourceCommit   | `48bdb76bace0b7d94059d8f4d3848f803aee8bb9`(在 `c5c6786` 基础上追其 favicon 修复) |
| tokenVersion   | 0.2.1                                                                            |
| 快照 dirty     | 否(纯提交快照)                                                                   |
| 逐文件 SHA-256 | 见 `idrl-source.json` 与 idrl-vi `npm run vi:export` 输出                        |

## 接入深度

「已有 shadcn / Tailwind v4」路线(见 idrl-vi `docs/design/adoption.md`):
保留业务、API、权限、路由与组件体系,接语义 token / logo / 字体,
再校准尺寸、圆角、状态与信息层次;工作台外观对齐 IDRL AppShell。

## 复制资产

| 资产                | 目标路径              | 说明                                                                                                                          |
| ------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| logo SVG ×8         | `public/brand/logo/`  | symbol-color(-reverse)、lockup-idrl(-reverse)、lockup-bilingual(-reverse)、favicon-tile、favicon                              |
| favicon.svg         | `src/app/icon.svg`    | Next.js App Router 图标约定;透明底,内嵌 `prefers-color-scheme` 随浏览器标签栏明暗自适应(navy ↔ navyOnDark),不随应用内主题按钮 |
| InterVariable.woff2 | `public/brand/fonts/` | 自托管英文字体(globals.css `@font-face`)                                                                                      |
| Inter-LICENSE.txt   | `public/brand/fonts/` | OFL 授权,随字体保留                                                                                                           |

favicon 规范(上游 48bdb76 起):默认浏览器 favicon 用透明自适应的
`favicon.svg`;navy 方底 `favicon-tile.svg` 仅用于需要固定底色的应用图标 /
快捷方式,不再作浏览器默认图标。

token 数值(tokens-values.css / shadcn-aliases.css 生成物)已并入
`src/app/globals.css` 并保持本应用原变量名(`--mute`、`--link`、`--*-soft` 等),
避免全库调用点改名;映射关系:

- `--background` ← `background`;`--card/--popover` ← `surface`;`--muted/--secondary` ← `surfaceSubtle`
- `--primary` ← `primary`(brand blue);`--ring` ← `focus`;`--input` ← `controlBorder`
- `--success/--warning/--destructive` ← 同名 IDRL 语义色;`--*-soft` = 基色 15% 混 surface(徽章规格)
- `--error-deep/--warning-deep/--primary-text` ← `*Text`;`--hairline-strong` ← `controlBorder`
- 圆角:控件 6px(`rounded-md`)/ 卡片 12px(`rounded-lg`)/ 弹窗 16px(`rounded-xl`)
- 阴影:面板无投影(`--shadow-l1/l2` = none,靠边框分层),浮层投影(`l3` tooltip / `l5` 弹窗)

## 主题协议

根元素同时持有 `.dark` class 与 `data-theme="light|dark"`(next-themes
`attribute={['class','data-theme']}`,system 默认)。CSS 变体走 `.dark`,
品牌 logo 浅/深版本按 `data-theme` 切换(`.brand-theme-light/dark`,
深底用官方 reverse SVG,不做滤镜)。

## 本地适配(与 idrl-vi 参考实现的差异)

- **AppShell**:未复制 idrl-vi 的 `app-shell.tsx`(其面向 Vite/hash 路由),
  而是按其规格重写既有 `DashboardShell`/`AppSidebar`/`SiteHeader`:
  240px 展开 / 72px 窄栏 / <768px 模态抽屉、分组导航(组标签 12px/.12em)、
  active 项 = surface 底 + 3px primary 内嵌左缘 + 加粗、topline 68px +
  面包屑(移动端只留末级)、折叠偏好仍走本应用 cookie(服务端首屏无闪烁)。
- **品牌节点**:`components/layout/brand.tsx` 移植自 idrl-vi `brand.tsx`,
  资产路径改为 `public/brand/`。
- **caption-mono 类名保留但重定义**:旧 Vercel mono 大写眉题改为 IDRL
  eyebrow(12px/700/.16em/muted),全库调用点无需改动。
- **徽章 API 保留、视觉对齐**:variant 名不变(default/secondary/success/
  warning/error/outline),新增 `info`;样式为 IDRL 圆点 + 5px 圆角 +
  15% 混底。语义变化:`success` 由旧「link 蓝」改为 IDRL 绿,
  与 IDRL「状态用 success/warning/destructive」一致。
- **Alert 横幅**:按 IDRL 规格(5% 底 / 30% 边界 / *Text 文字)。
- **changelog 页**:套用 IDRL release 模板(左版本元信息、右变更内容、
  分类 12% 品牌蓝药丸),数据源仍为仓库根 CHANGELOG.md。
- 未引入 idrl-vi 的 styles.css / design-refresh.css 全局参考样式
  (含官网布局与 reset),按组件逐项迁移,未覆盖业务样式。
- 动态中文走官方回退栈(`--font-sans`),未引入展示站中文子集。

## 验证

- `npm run check-types` / `npm run lint` / `npm test`(369 通过)/ `npm run build` 通过。
- 浏览器截图验收(mock 模式,dev server):工作台/项目管理/业务录入/统计分析/
  审批中心/更新日志/项目概览/执行台账 × 浅色 1440px、深色 1440px、浅色 390px;
  主题切换联动(data-theme + logo 互换)、72px 窄栏、移动端指标无溢出均已核对。
- 已知剩余项:SSO 登录页仅在 MOCK_AUTH=false 可见(逻辑简单、品牌资产复用
  已验证路径,未单独截图);完整屏幕阅读器与跨浏览器人工验收未执行
  (与 idrl-vi 上游同等边界)。
