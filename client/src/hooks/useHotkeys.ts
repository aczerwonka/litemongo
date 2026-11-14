import { useEffect, useRef } from 'react';

/**
 * Global keyboard shortcuts.
 *
 * Browsers reserve Ctrl/Cmd+T, +W, +N, +Tab, +1..9 and never deliver them to the
 * page, so app-level shortcuts use Alt instead. Combos are matched on the
 * physical key (`KeyboardEvent.code`) because on macOS Alt+letter types a
 * different character. Format: `[mod+][alt+][shift+]<code>`, where `mod` is Ctrl
 * or Cmd, e.g. `mod+Enter`, `alt+KeyT`, `alt+Digit1`, `shift+Slash`.
 */
export type Hotkeys = Record<string, (e: KeyboardEvent) => void>;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function comboOf(e: KeyboardEvent): string {
  return `${e.ctrlKey || e.metaKey ? 'mod+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${e.code}`;
}

export function useHotkeys(bindings: Hotkeys, enabled = true): void {
  const ref = useRef(bindings);
  ref.current = bindings;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const combo = comboOf(e);
      // `key:<char>` bindings match the typed character, whatever the keyboard layout.
      const handler = ref.current[combo] ?? (e.ctrlKey || e.metaKey || e.altKey ? undefined : ref.current[`key:${e.key}`]);
      if (!handler) return;
      // Shortcuts without Ctrl/Cmd/Alt must not fire while the user is typing.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && isTyping(e.target)) return;
      // An open dialog owns the keyboard (Esc closes it).
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      handler(e);
    };
    // Capture phase: runs before Monaco or a focused input can swallow the key.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Human-readable label for a combo, e.g. `alt+KeyT` -> "⌥T" (macOS) / "Alt+T". */
export function comboLabel(combo: string): string {
  const parts = combo.split('+');
  const code = parts.pop() as string;
  const key =
    { BracketLeft: '[', BracketRight: ']', Slash: '/', Enter: 'Enter', Escape: 'Esc', Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[code] ??
    code.replace(/^Key|^Digit/, '');
  const mods = parts.map((m) =>
    m === 'mod' ? (isMac ? '⌘' : 'Ctrl') : m === 'alt' ? (isMac ? '⌥' : 'Alt') : isMac ? '⇧' : 'Shift',
  );
  return isMac ? `${mods.join('')}${key}` : [...mods, key].join('+');
}
