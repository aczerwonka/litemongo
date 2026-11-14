import { useRef } from 'react';
import { useLayoutStore } from '../store/useLayoutStore';

/**
 * Drag handle that resizes the pane above it (height in px, persisted under
 * `sizeKey`). Double-click restores the default size. Arrow keys nudge by 16 px.
 */
export function Splitter({
  sizeKey,
  size,
  min = 48,
  max = 900,
  label = 'Resize',
}: {
  sizeKey: string;
  size: number;
  min?: number;
  max?: number;
  label?: string;
}) {
  const setSize = useLayoutStore((s) => s.setSize);
  const resetSize = useLayoutStore((s) => s.resetSize);
  const drag = useRef<{ y: number; size: number } | null>(null);
  const clamp = (px: number) => Math.min(Math.max(px, min), Math.min(max, window.innerHeight - 120));

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={`${label} (drag, double-click to reset)`}
      className="group -my-1 flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, size };
        document.body.style.cursor = 'row-resize';
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        setSize(sizeKey, clamp(drag.current.size + e.clientY - drag.current.y));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        document.body.style.cursor = '';
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onDoubleClick={() => resetSize(sizeKey)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          setSize(sizeKey, clamp(size + (e.key === 'ArrowDown' ? 16 : -16)));
        }
      }}
    >
      <div className="h-1 w-16 rounded-full bg-zinc-700 transition-colors group-hover:bg-emerald-500 group-focus-visible:bg-emerald-500" />
    </div>
  );
}
