import Link from 'next/link';

import pkg from '../../../../package.json';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** 关于页:系统简介、核心能力与版本信息(纯静态,版本号来自 package.json)。 */
export default function AboutPage() {
  const features: [string, string][] = [
    [
      '预算编制与审批',
      '初始预算编制(树形科目、模板预设)、提交/审批/驳回,预算调整与科目变更走独立审批流',
    ],
    ['业务记录与结算单导入', '逐笔登记支出,财务系统结算单 xlsx 直接导入,单据编号查重防重单'],
    ['执行台账与统计', '实时执行台账(年度/总预算双口径)、自定义统计、月度历史、经费余额视图'],
    ['权限分级', '管理员/普通用户全局分级,项目内负责人(可改预算)与录入人员(仅录账)正交授权'],
    ['API 凭证自动化', '服务账号 + API Key 供 coding agent 无人值守对账、导入与对账查询'],
  ];
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="ABOUT" title="关于" description="科研项目预算管理系统" />
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">系统简介</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-6 text-muted-foreground">
            面向科研经费的全生命周期预算管理:从初始预算编制与审批,到业务记录登记、结算单导入、
            预算调整,再到执行台账与统计分析。年度预算回归「当年计划」定位,支持以总预算剩余额度
            为锚的余额式编制;所有敏感操作(审批、作废、权限变更)均留审计痕迹。
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {features.map(([title, desc]) => (
              <div key={title} className="rounded-lg border border-border p-3">
                <p className="text-sm font-medium">{title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">版本与技术</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">当前版本:</span>
            <Badge variant="secondary">v{pkg.version}</Badge>
            <Button variant="link" size="sm" className="h-auto p-0" asChild>
              <Link href="/changelog">查看更新日志</Link>
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              'Next.js 16 (App Router)',
              'React 19',
              'Prisma + PostgreSQL',
              'Tailwind CSS 4',
              'shadcn/ui',
            ].map((t) => (
              <Badge key={t} variant="outline">
                {t}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
