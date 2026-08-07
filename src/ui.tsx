import type { ReactNode } from 'react';
import { linkify } from './linkify';

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-line bg-ink-800/70 elev-card backdrop-blur-sm ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * A small uppercase eyebrow. Kept uppercase deliberately: it separates
 * structural labels from content at a glance without needing a heavier weight
 * or a rule underneath.
 */
export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-mist-500">
        {children}
      </h2>
      {hint && <span className="text-xs text-mist-500">{hint}</span>}
    </div>
  );
}

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    'bg-accent-500 text-white shadow-sm shadow-accent-500/25 hover:bg-accent-400 active:bg-accent-500 disabled:bg-raise-2 disabled:text-mist-500 disabled:shadow-none',
  ghost:
    'border border-line bg-raise-1 text-mist-300 hover:border-line-strong hover:bg-raise-2 hover:text-fg',
  danger:
    'border border-rose-400/20 bg-rose-500/10 text-danger hover:border-rose-400/30 hover:bg-rose-500/20',
  subtle: 'text-mist-400 hover:bg-raise-2 hover:text-fg',
};

export function Button({
  children,
  variant = 'ghost',
  className = '',
  ...rest
}: { children: ReactNode; variant?: ButtonVariant } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-150 disabled:cursor-not-allowed ${BUTTON_STYLES[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-mist-500">
        {label}
      </span>
      {children}
    </label>
  );
}

const CONTROL =
  'rounded-lg border border-line bg-ink-900/60 px-3 py-2 text-sm text-mist-200 transition-colors outline-none placeholder:text-mist-500 hover:border-line-strong focus:border-accent-400/70 focus:bg-ink-900/80 focus:ring-[3px] focus:ring-accent-500/15';

export function TextInput(props: React.ComponentPropsWithRef<'input'>) {
  return <input {...props} className={`${CONTROL} ${props.className ?? ''}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${CONTROL} resize-y ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`${CONTROL} cursor-pointer appearance-none bg-[length:10px] bg-[right_0.75rem_center] bg-no-repeat pr-9 ${props.className ?? ''}`}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath fill='none' stroke='%238a94ad' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round' d='M1 1.5L6 6.5l5-5'/%3E%3C/svg%3E\")",
        ...props.style,
      }}
    />
  );
}

export function Badge({
  children,
  className = '',
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * One quiet metadata line, dot-separated. This replaces the row of coloured
 * pills that used to sit under every task title: the information is identical,
 * but it now reads as a sentence instead of competing for attention.
 */
export function Meta({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-mist-400 ${className}`}
    >
      {children}
    </div>
  );
}

export function MetaDot() {
  return <span aria-hidden="true" className="text-mist-500/50">·</span>;
}

/** A coloured dot used to identify a project or a focus level inline. */
export function Dot({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${className}`}
      style={style}
    />
  );
}

/** A thin progress bar. `value` is 0–1. */
export function Progress({ value, className = '' }: { value: number; className?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className={`h-1 overflow-hidden rounded-full bg-raise-2 ${className}`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-accent-400/70 transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * Renders text with any URLs or email addresses in it turned into real links.
 *
 * `stopPropagation` is defensive: no ancestor currently handles clicks, but the
 * moment a row becomes selectable, following a link inside it must not also
 * trigger the row.
 */
export function Linkified({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((seg, i) =>
        seg.kind === 'link' ? (
          <a
            key={i}
            href={seg.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-link underline decoration-link/40 underline-offset-2 transition-colors hover:decoration-link"
          >
            {seg.text}
          </a>
        ) : (
          seg.text
        ),
      )}
    </>
  );
}
