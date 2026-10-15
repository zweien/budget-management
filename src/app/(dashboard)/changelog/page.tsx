import * as React from 'react';

import { getChangelog } from '@/lib/changelog';

/** 条目内的最小行内标记:`code`、**bold**、[text](url)。服务端渲染,不注入原始 HTML。 */
function InlineMd({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <span key={i} className="font-medium text-foreground">
              {part.slice(2, -2)}
            </span>
          );
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code
              key={i}
              className="rounded-sm border border-border bg-muted/50 px-1 py-0.5 font-mono text-[0.85em]"
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (link) {
          // 安全加固(审计 bm1 审计 changelog href):scheme 白名单,
          // 防 javascript:/data: 等可执行协议进入 href(当前输入仅仓库内 CHANGELOG,
          // 此为对未来内容源变化的纵深防御)。
          const href = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(link[2])
            ? /^(https?:|mailto:)/i.test(link[2])
              ? link[2]
              : null
            : link[2]; // 相对/锚点链接放行
          if (href === null) {
            return <React.Fragment key={i}>{link[1]}</React.Fragment>;
          }
          return (
            <a
              key={i}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-link underline-offset-4 hover:underline"
            >
              {link[1]}
            </a>
          );
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
  );
}

/**
 * 更新日志:渲染仓库根 CHANGELOG.md(Keep a Changelog)。
 * 布局移植 IDRL release 模板:左版本元信息、右变更内容,分类用 12% 品牌蓝药丸。
 * 单一数据源在 git 中,版本发布流程见 AGENTS.md。
 */
export default async function ChangelogPage() {
  const releases = await getChangelog();

  return (
    <div className="mx-auto max-w-[1040px]">
      <div className="border-b border-border pb-8">
        <h1 className="text-display-lg">更新日志</h1>
        <p className="mt-3 max-w-[680px] leading-7 text-muted-foreground">
          版本历史与变更摘要。遵循 Keep a Changelog 与语义化版本。
        </p>
      </div>

      {releases.length === 0 ? (
        <p className="py-9 text-sm text-muted-foreground">暂无更新记录。</p>
      ) : (
        <ol>
          {releases.map((release) => (
            <li
              key={release.version}
              className="grid gap-5 border-b border-border py-7 max-lg:grid-cols-1 lg:grid-cols-[170px_minmax(0,1fr)] lg:gap-8 lg:py-9"
            >
              <div>
                <h2 className="text-[23px] leading-[1.4] font-bold">v{release.version}</h2>
                <time className="mt-2.5 block text-[13px] text-muted-foreground">
                  {release.date}
                </time>
              </div>
              <div>
                {release.sections.map((section) => (
                  <section
                    key={section.title}
                    className="grid grid-cols-[58px_minmax(0,1fr)] items-start gap-3 py-1.5"
                  >
                    <span className="rounded bg-[color-mix(in_srgb,var(--primary)_12%,var(--surface))] px-2 py-[3px] text-center text-xs text-primary-text">
                      {section.title}
                    </span>
                    <ul className="space-y-3 text-sm leading-7 text-muted-foreground">
                      {section.items.map((item, ii) => (
                        <li key={ii}>
                          <InlineMd text={item} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
