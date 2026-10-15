# Issue tracker: Local Markdown

这个 repo 的 issues 和 specs 作为 markdown 文件存放在 `.scratch/` 中。

## Conventions

- 每个 feature 一个目录：`.scratch/<feature-slug>/`
- Spec 是 `.scratch/<feature-slug>/spec.md`
- Implementation issues 是 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号，每个 ticket 一个文件，**不要**合成单个 tickets 文件
- Triage state 记录为每个 issue file 顶部附近的 `Status:` 行（role 字符串见 `triage-labels.md`）
- Comments 和 conversation history 追加到文件底部的 `## Comments` heading 下

## When a skill says "publish to the issue tracker"

在 `.scratch/<feature-slug>/` 下创建新文件（必要时创建目录）。

## When a skill says "fetch the relevant ticket"

读取引用路径处的文件。用户通常会直接传入路径或 issue number。

## Wayfinding operations

由 `/wayfinder` 使用。**Map** 是一个文件，每个 ticket 对应一个 **child** 文件。

- **Map**：`.scratch/<effort>/map.md`（正文为 Notes / Decisions-so-far / Fog）。
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号，正文写问题。`Type:` 行记录 ticket 类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **Blocking**：顶部附近的 `Blocked by: NN, NN` 行。当其列出的每个文件都 `resolved` 时，该 ticket 解除阻塞。
- **Frontier**：扫描 `.scratch/<effort>/issues/` 中 open、unblocked 且 unclaimed 的文件；编号最小者胜。
- **Claim**：动工前先设 `Status: claimed` 并保存。
- **Resolve**：把答案追加到 `## Answer` heading 下，设 `Status: resolved`，然后把 context 指针（gist + 链接）追加到 `map.md` 的 Decisions-so-far。
