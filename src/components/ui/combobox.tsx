'use client';

import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface ComboboxOption {
  value: string;
  label: string;
  /** 搜索时一并匹配的辅助文本(如编号)。 */
  keywords?: string;
}

interface ComboboxProps {
  options: ComboboxOption[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  /** 未选择时是否允许清除(显示清除项)。 */
  clearable?: boolean;
}

/**
 * 可搜索单选(shadcn Combobox 模式:Popover + cmdk)。
 * 用于成员管理用户选择、统一录入页项目/科目级联选择等长列表场景。
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = '请选择',
  searchPlaceholder = '搜索…',
  emptyText = '无匹配项',
  disabled,
  className,
  clearable,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('justify-between font-normal', !selected && 'text-mute', className)}
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronsUpDown className="shrink-0 text-mute" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command
          filter={(_, search, keywords) =>
            String(keywords?.join(' ') ?? '')
              .toLowerCase()
              .includes(search.toLowerCase())
              ? 1
              : 0
          }
        >
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {clearable && value ? (
              <CommandItem
                value="__clear__"
                keywords={['清除']}
                onSelect={() => {
                  onChange('');
                  setOpen(false);
                }}
              >
                <span className="text-mute">清除选择</span>
              </CommandItem>
            ) : null}
            {options.map((o) => (
              <CommandItem
                key={o.value}
                value={o.value}
                keywords={[o.label, o.keywords ?? '']}
                onSelect={() => {
                  onChange(o.value === value ? (clearable ? '' : o.value) : o.value);
                  setOpen(false);
                }}
              >
                <Check className={cn('size-4', value === o.value ? 'opacity-100' : 'opacity-0')} />
                <span className="truncate">{o.label}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
