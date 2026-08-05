import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** CHANGELOG.md(Keep a Changelog 格式)的解析结果。 */
export interface ChangelogSection {
  /** 小节标题(如 新增 / 变更 / 修复)。 */
  title: string;
  items: string[];
}

export interface ChangelogRelease {
  version: string;
  /** YYYY-MM-DD;未发布版本可为 'Unreleased' 原文。 */
  date: string;
  sections: ChangelogSection[];
}

const RELEASE_RE = /^## \[(.+?)\] - (.+?)\s*$/;
const SECTION_RE = /^###\s+(.+?)\s*$/;
const ITEM_RE = /^-\s+(.+?)\s*$/;

/**
 * 解析 Keep a Changelog 文本:
 * `## [版本] - 日期` 开版本,`### 小节` 开分组,`- 条目` 进当前小节。
 * 其余行(标题、前言、空行)忽略;结构之外的行兜底并入一个「其他」小节。
 */
export function parseChangelog(text: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;

  const ensureSection = (): ChangelogSection => {
    if (!release) throw new Error('changelog 条目必须位于某个版本节内');
    if (!section) {
      section = { title: '其他', items: [] };
      release.sections.push(section);
    }
    return section;
  };

  for (const line of text.split('\n')) {
    const releaseMatch = RELEASE_RE.exec(line);
    if (releaseMatch) {
      release = { version: releaseMatch[1], date: releaseMatch[2], sections: [] };
      releases.push(release);
      section = null;
      continue;
    }
    if (!release) continue; // 前言区(# 标题、说明段)跳过
    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      section = { title: sectionMatch[1], items: [] };
      release.sections.push(section);
      continue;
    }
    const itemMatch = ITEM_RE.exec(line);
    if (itemMatch) {
      ensureSection().items.push(itemMatch[1]);
    }
  }
  return releases;
}

/**
 * 读取仓库根 CHANGELOG.md。
 * 生产 standalone 部署时由 next.config 的 outputFileTracingIncludes 保证文件随包。
 */
export async function getChangelog(): Promise<ChangelogRelease[]> {
  const text = await readFile(path.join(process.cwd(), 'CHANGELOG.md'), 'utf8');
  return parseChangelog(text);
}
