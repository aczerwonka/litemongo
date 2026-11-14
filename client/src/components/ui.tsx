import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { create } from 'zustand';
import { api } from '../lib/api';

type Variant = 'default' | 'primary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  default: 'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700',
  primary: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  danger: 'bg-red-700 hover:bg-red-600 text-white',
  ghost: 'hover:bg-zinc-800 text-zinc-300',
};

export function Button({
  variant = 'default',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

export const inputClass =
  'rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-emerald-500';

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-zinc-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
  size,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** "full" fills most of the window (editors with their own scroll areas). */
  size?: 'full';
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Take keyboard focus while open (unless a field inside asked for it), give it back on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Only the topmost dialog reacts.
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] === ref.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={`flex w-full flex-col rounded-lg border outline-none border-zinc-700 bg-zinc-900 shadow-2xl ${size === 'full' ? 'h-[90vh] max-w-[1400px]' : `max-h-[90vh] ${wide ? 'max-w-5xl' : 'max-w-lg'}`}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" aria-label="Close" className="text-zinc-400 hover:text-zinc-100" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className={`min-h-0 flex-1 p-4 ${size === 'full' ? 'overflow-hidden' : 'overflow-auto'}`}>{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-200">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

const useToastStore = create<{ toasts: Toast[]; push: (text: string, tone?: Toast['tone']) => void }>((set) => ({
  toasts: [],
  push: (text, tone = 'info') => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
  },
}));

export const toast = (text: string, tone?: Toast['tone']) => useToastStore.getState().push(text, tone);

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`rounded px-3 py-2 text-sm shadow-lg ${t.tone === 'error' ? 'bg-red-800 text-red-50' : 'bg-zinc-700 text-zinc-50'}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Server info
// ---------------------------------------------------------------------------

export function useServerInfo() {
  return useQuery({ queryKey: ['health'], queryFn: api.health, staleTime: 60_000 });
}

/**
 * Button that opens a small panel below it (fixed-positioned, so scrolling
 * containers never clip it). Closes on outside click and Escape.
 */
export function Dropdown({
  label,
  title,
  className = '',
  panelClassName = '',
  width = 320,
  children,
}: {
  label: ReactNode;
  title?: string;
  className?: string;
  panelClassName?: string;
  width?: number;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, maxHeight: 400 });
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setPos({
      top: r.bottom + 4,
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      maxHeight: Math.max(160, window.innerHeight - r.bottom - 16),
    });
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panelRef.current?.contains(target) && !anchorRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        anchorRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => setOpen(false);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${open ? 'border-emerald-600 text-zinc-100' : 'border-zinc-700 hover:text-zinc-100'} ${className}`}
      >
        {label}
        <span className="text-[10px] opacity-60">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          className={`fixed z-50 overflow-auto rounded-md border border-zinc-700 bg-zinc-900 p-2 text-xs text-zinc-300 shadow-xl ${panelClassName}`}
          style={{ top: pos.top, left: pos.left, width, maxHeight: pos.maxHeight }}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </>
  );
}
