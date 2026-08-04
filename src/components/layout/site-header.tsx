'use client';

import * as React from 'react';
import { Menu } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { SidebarBrand, SidebarNav } from '@/components/layout/app-sidebar';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { MockUserSelector } from '@/components/auth/MockUserSelector';

/** DESIGN.md nav-bar 规格:64px 高、canvas 面、hairline 底边。 */
export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-border bg-card px-4 lg:px-6">
      {/* 移动端抽屉导航 */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label="打开导航菜单"
          onClick={() => setMobileOpen(true)}
        >
          <Menu />
        </Button>
        <SheetContent side="left" className="w-64 gap-0 p-0">
          <SheetTitle className="sr-only">导航菜单</SheetTitle>
          <SidebarBrand />
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="ml-auto flex items-center gap-2">
        <MockUserSelector />
        <ThemeToggle />
      </div>
    </header>
  );
}
