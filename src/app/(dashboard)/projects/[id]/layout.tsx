import { ProjectShell } from '@/components/layout/project-shell';

/**
 * 项目子页嵌套布局:渲染项目上下文壳(名称 + Tab 子导航)。
 * 子页只保留各自内容,标题中的"— 项目名"后缀由壳统一承载。
 */
export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return <ProjectShell>{children}</ProjectShell>;
}
