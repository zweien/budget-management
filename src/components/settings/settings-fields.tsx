'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import type { SystemSettingsSnapshot } from '@/lib/system-settings';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/** 三张设置卡片共用的入参。 */
export interface SettingsCardProps {
  /** 最近一次保存成功的生效值:卡片的基线,与它不同即为未保存修改。 */
  saved: SystemSettingsSnapshot;
  onSaved: (next: SystemSettingsSnapshot) => void;
}

/**
 * 设置卡片外壳:标题 + 说明 + 字段区 + 底部保存栏。
 * 每张卡片独立保存,只提交自己的键,互不覆盖。
 */
export function SettingsCard({
  title,
  description,
  dirty,
  saving,
  saveDisabled = false,
  onSave,
  onReset,
  children,
}: {
  title: string;
  description: string;
  dirty: boolean;
  saving: boolean;
  /** 字段本身不合法时额外禁用保存(与「无修改」区分:仍然提示有未保存修改)。 */
  saveDisabled?: boolean;
  onSave: () => void;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
      <CardFooter className="gap-2 border-t border-border pt-4">
        <span className="mr-auto text-xs text-warning-deep" role="status">
          {dirty ? '有未保存的修改' : ''}
        </span>
        <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={onReset}>
          放弃修改
        </Button>
        <Button size="sm" disabled={!dirty || saving || saveDisabled} onClick={onSave}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** 卡片内的分组小标题。 */
export function FieldGroupTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-sm font-bold tracking-[-0.01em]">{children}</p>;
}

/** 文本字段:单行 Input 或多行 Textarea,带字数上限与计数。 */
export function TextField({
  label,
  value,
  onChange,
  maxLength,
  hint,
  multiline = false,
  rows = 5,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  maxLength: number;
  hint: string;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  className?: string;
}) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  const shared = {
    id,
    value,
    maxLength,
    placeholder,
    'aria-describedby': hintId,
  };
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {multiline ? (
        <Textarea
          {...shared}
          rows={rows}
          className="min-h-32"
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input {...shared} onChange={(e) => onChange(e.target.value)} />
      )}
      <p id={hintId} className="text-xs text-mute">
        {hint}
        <span className="tabular-nums">
          ({value.length}/{maxLength})
        </span>
      </p>
    </div>
  );
}

/** 下拉字段。 */
export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
  hint: string;
}) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id} className="w-full sm:w-80" aria-describedby={hintId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={hintId} className="text-xs text-mute">
        {hint}
      </p>
    </div>
  );
}
