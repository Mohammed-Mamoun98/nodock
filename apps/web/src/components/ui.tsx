import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { Tone } from '../lib/status';

const toneText: Record<Tone, string> = {
  lime: 'text-lime',
  amber: 'text-amber',
  red: 'text-red',
  steel: 'text-steel',
};

const toneDot: Record<Tone, string> = {
  lime: 'bg-lime',
  amber: 'bg-amber',
  red: 'bg-red',
  steel: 'border border-steel bg-transparent',
};

const toneBorder: Record<Tone, string> = {
  lime: 'border-lime/30 text-lime',
  amber: 'border-amber/30 text-amber',
  red: 'border-red/30 text-red',
  steel: 'border-steel/30 text-steel',
};

export function StatusDot({ tone, inFlight }: { tone: Tone; inFlight: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${toneDot[tone]} ${
        inFlight ? 'animate-pulse-dot' : ''
      }`}
    />
  );
}

export function StatusWord({
  label,
  tone,
  inFlight,
}: {
  label: string;
  tone: Tone;
  inFlight: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <StatusDot tone={tone} inFlight={inFlight} />
      <span
        className={`font-mono text-mono-xs ${tone === 'lime' ? 'text-text-dim' : 'text-text-dim'}`}
      >
        {label}
      </span>
    </span>
  );
}

export function StatusChip({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className={`inline-flex h-4 items-center justify-center rounded border px-1 font-mono text-[9px] uppercase ${toneBorder[tone]}`}
    >
      {label}
    </span>
  );
}

export function BranchChip({ branch }: { branch: string }) {
  return (
    <span className="max-w-[80px] truncate rounded border border-line px-1 text-[9px] uppercase">
      {branch}
    </span>
  );
}

type Variant = 'primary' | 'secondary' | 'ghost';

const variants: Record<Variant, string> = {
  primary: 'bg-lime text-lime-ink font-medium hover:bg-lime/90',
  secondary: 'border border-line text-text hover:bg-surface-2',
  ghost: 'text-text-dim hover:text-text',
};

export function Button({
  variant = 'secondary',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`inline-flex h-[28px] items-center gap-1.5 rounded-[6px] px-3 text-ui-sm transition-colors disabled:opacity-50 ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function LinkButton({
  variant = 'secondary',
  to,
  className = '',
  children,
}: {
  variant?: Variant;
  to: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={to}
      className={`inline-flex h-[28px] items-center gap-1.5 rounded-[6px] px-3 text-ui-sm transition-colors ${variants[variant]} ${className}`}
    >
      {children}
    </a>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="px-4 mb-2 font-mono text-mono-xs tracking-wide text-text-dim">{children}</h2>
  );
}

export function toneTextClass(tone: Tone) {
  return toneText[tone];
}
