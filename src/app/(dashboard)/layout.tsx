import { Menu } from 'antd';
import Sider from 'antd/es/layout/Sider';
import Layout, { Content, Header } from 'antd/es/layout/layout';
import Link from 'next/link';

import { MockUserSelector } from '@/components/auth/MockUserSelector';

// 注意:不要用 `const { Sider } = Layout` 顶层解构,也不要依赖 `Layout.Sider` 属性访问。
// antd 的 Layout.Header/Sider/Content 是运行期挂载的 compounded 属性
// (见 antd/es/layout/index.js)。在 Turbopack(Next 16)bundle 中这些副作用赋值不可靠,
// 导致其为 undefined → "Element type is invalid ... Check the render method of DashboardLayout"。
// 这里直接具名 / 默认导入各子组件的源模块,绕开 compounded 属性挂载。

// Dashboard 下所有页面均依赖 mock 鉴权 header + 运行时数据拉取,不可静态预渲染。
export const dynamic = 'force-dynamic';

/**
 * Dashboard 外壳:AntD Layout + 左侧 Sider 菜单 + 顶部 mock 用户选择器。
 * 嵌套于根 src/app/layout.tsx 之下(已提供 ConfigProvider + React-19 patch),此处不重复。
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="0" theme="light">
        <div
          style={{
            height: 56,
            margin: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            color: '#7c3aed',
          }}
        >
          预算管理系统
        </div>
        <Menu
          mode="inline"
          defaultSelectedKeys={['dashboard']}
          items={[
            {
              key: 'dashboard',
              label: <Link href="/">工作台</Link>,
            },
            {
              key: 'projects',
              label: <Link href="/projects">项目管理</Link>,
            },
            {
              key: 'approvals',
              label: <Link href="/approvals">审批中心</Link>,
            },
            {
              key: 'statistics',
              label: <Link href="/statistics">统计分析</Link>,
            },
            {
              key: 'audit-logs',
              label: <Link href="/audit-logs">操作日志</Link>,
            },
            {
              key: 'budget-placeholder',
              label: '预算编制',
              disabled: true,
            },
            {
              key: 'ledger-placeholder',
              label: '执行台账',
              disabled: true,
            },
          ]}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
          }}
        >
          <MockUserSelector />
        </Header>
        <Content style={{ margin: 24 }}>
          <div style={{ background: '#fff', padding: 24, borderRadius: 8, minHeight: 360 }}>
            {children}
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
