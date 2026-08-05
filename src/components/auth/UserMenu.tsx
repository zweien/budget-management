'use client';

import * as React from 'react';
import { LogOut, UserRound } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const ROLE_LABEL: Record<string, string> = {
  ADMIN: '预算管理员',
  USER: '普通用户',
};

/**
 * SSO 模式的顶栏用户菜单:姓名 + 角色 Badge + 退出登录。
 * (mock 模式由 MockUserSelector 占用同一槽位;见 AuthWidget。)
 */
export function UserMenu({ name, role }: { name: string; role: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-accent">
            <UserRound className="size-3.5" />
          </span>
          <span className="max-w-32 truncate text-sm">{name}</span>
          <Badge variant={role === 'ADMIN' ? 'default' : 'warning'}>
            {ROLE_LABEL[role] ?? role}
          </Badge>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{name}</span>
            <span className="caption-mono text-mute">{ROLE_LABEL[role] ?? role}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-error-deep focus:text-error-deep"
          onSelect={() => {
            // 整页跳转(route handler 清会话 + 跳 Authentik end-session)。
            window.location.href = '/api/auth/logout';
          }}
        >
          <LogOut />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
