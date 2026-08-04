## Agent skills

### Issue tracker

Issues 存放在本 repo 的 `.scratch/<feature>/` 目录下作为 markdown 文件。See `docs/agents/issue-tracker.md`.

### Triage labels

使用五个 canonical roles 的默认 label 字符串。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context 布局（repo 根目录一个 `CONTEXT.md` + `docs/adr/`）。See `docs/agents/domain.md`.

## Browser automation

playwright-cli 浏览器自动化使用 chromium：本机未安装 Chrome 发行版（`/opt/google/chrome/chrome` 不存在，安装需 sudo),`playwright-cli open` 必须带 `--browser=chromium`(Playwright 自带 chromium 已装在 `~/.cache/ms-playwright/`)。截图等临时产物已被 `.gitignore`(`*.png`、`.playwright-cli/`)。
