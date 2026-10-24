import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface DropdownItem {
  id: string;
  label: string;
  meta?: string;
}

/**
 * Small popover menu: no portal, no floating-UI. Positioning is a plain absolute
 * box inside a relative wrapper, which is all a top-bar switcher needs.
 */
export function Dropdown({
  label,
  items,
  activeId,
  onSelect,
  align = 'left',
  emptyLabel = 'nothing here',
  ariaLabel,
  trailing,
}: {
  label: string;
  items: DropdownItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  align?: 'left' | 'right';
  emptyLabel?: string;
  ariaLabel: string;
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        className={`flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-ui-sm transition-colors ${
          open
            ? 'border-lime/40 bg-surface-2 text-text'
            : 'border-line bg-surface-2/60 text-text hover:border-line-strong'
        }`}
      >
        <span className="max-w-[160px] truncate">{label}</span>
        {trailing}
        <Icon name="chevron-down" className="text-text-dim" />
      </button>

      {open ? (
        <div
          role="menu"
          className={`absolute top-[calc(100%+4px)] z-50 min-w-[200px] overflow-hidden rounded-md border border-line bg-surface shadow-lg ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {items.length === 0 ? (
            <p className="px-3 py-2 font-mono text-mono-xs text-text-dim">{emptyLabel}</p>
          ) : null}

          {items.map((item) => {
            const active = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onSelect(item.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 border-l-2 px-3 py-1.5 text-left text-ui-sm transition-colors ${
                  active
                    ? 'border-l-lime bg-surface-2 text-text'
                    : 'border-l-transparent text-text-dim hover:bg-surface-2/60 hover:text-text'
                }`}
              >
                <span className="truncate">{item.label}</span>
                {item.meta ? (
                  <span className="shrink-0 font-mono text-mono-xs text-text-dim">{item.meta}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
