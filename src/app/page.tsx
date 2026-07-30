'use client';

import Link from 'next/link';
import { Card, Typography, Button } from 'antd';

const { Title, Paragraph } = Typography;

/**
 * 根落地页:替代 create-next-app 默认营销页(M4 修复)。
 * 简单的标题卡片 + 进入「项目管理」入口。详细业务页均在 /projects 之下。
 * 用 client component 以确保 AntD cssinjs 在 SSR 时正确收集样式。
 */
export default function Home() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f5f5f5',
        padding: 24,
      }}
    >
      <Card style={{ maxWidth: 520, width: '100%', textAlign: 'center' }}>
        <Title level={2} style={{ color: '#7c3aed', marginBottom: 8 }}>
          预算管理系统
        </Title>
        <Paragraph type="secondary">
          科研项目预算管理:项目 → 初始预算编制 → 审批生效 → 预算执行台账全链路。
        </Paragraph>
        <Link href="/projects">
          <Button type="primary" size="large">
            进入项目管理
          </Button>
        </Link>
      </Card>
    </div>
  );
}
