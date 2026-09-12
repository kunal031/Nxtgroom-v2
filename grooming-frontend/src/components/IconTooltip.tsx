import type { ReactNode } from 'react';

interface IconTooltipProps {
  /** What the icon means, in a few words. */
  label: string;
  /** The control itself. It keeps its own aria-label; this is visual only. */
  children: ReactNode;
}

/**
 * A label that appears the moment an icon is hovered or focused.
 *
 * The browser's own `title` attribute waits roughly a second before showing
 * anything, which is long enough that somebody scanning a column of unfamiliar
 * icons gives up and clicks one to find out. That is the wrong way to learn what
 * a destructive or state-changing control does.
 *
 * Purely visual: it is aria-hidden and every control it wraps keeps its own
 * aria-label, so a screen reader hears the name once rather than twice.
 */
export default function IconTooltip({ label, children }: IconTooltipProps) {
  return (
    <span className="relative inline-flex group/tip">
      {children}
      <span
        role="presentation"
        aria-hidden="true"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] font-semibold text-white opacity-0 shadow-lg transition-opacity duration-75 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
