import * as React from 'react';

import { getChangelog } from '@/lib/changelog';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';

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
          return (
            <a
              key={i}
              href={link[2]}
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
 * 单一数据源在 git 中,版本发布流程见 AGENTS.md。
 */
export default async function ChangelogPage() {
  const releases = await getChangelog();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        eyebrow="CHANGELOG"
        title="更新日志"
        description="版本历史与变更摘要。遵循 Keep a Changelog 与语义化版本。"
      />

      {releases.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无更新记录。</p>
      ) : (
        <ol className="space-y-4">
          {releases.map((release, ri) => (
            <li
              key={release.version}
              className="rounded-lg border border-border bg-card p-5 shadow-l2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={ri === 0 ? 'default' : 'outline'} className="font-mono">
                  v{release.version}
                </Badge>
                <span className="caption-mono text-mute">{release.date}</span>
              </div>
              <div className="mt-4 space-y-4">
                {release.sections.map((section) => (
                  <section key={section.title}>
                    <h2 className="text-sm font-medium">{section.title}</h2>
                    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-mute">
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
