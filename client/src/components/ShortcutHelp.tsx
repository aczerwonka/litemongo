import { comboLabel } from '../hooks/useHotkeys';
import { useUiStore } from '../store/useUiStore';
import { Modal } from './ui';

/** Single source of truth for the shortcut cheat sheet (Shift+/ or Alt+/). */
const GROUPS: { title: string; items: [keys: string[], what: string][] }[] = [
  {
    title: 'Query',
    items: [
      [['mod+Enter'], 'Run the query'],
      [['alt+KeyF'], 'Focus the filter editor'],
      [['alt+KeyG'], 'Focus the results grid'],
      [['alt+KeyV'], 'Next view: Table → Master-detail → Nested table → Tree'],
      [['alt+KeyL'], 'Link a collection (relation)'],
      [['alt+KeyS'], 'Schema of the current collection'],
      [['alt+KeyI'], 'Collection indexes'],
      [['alt+KeyC'], 'Copy results as EJSON'],
      [['alt+KeyP'], 'Paste an EJSON bundle'],
    ],
  },
  {
    title: 'Results grid',
    items: [
      [['ArrowUp', 'ArrowDown'], 'Move between rows (also j / k)'],
      [['Home', 'End'], 'First / last row'],
      [['Space'], 'Select the row for copying'],
      [['Enter', 'ArrowRight'], 'Open the row: detail pane, or document tree in Table view'],
      [['ArrowLeft', 'Escape'], 'Back to the parent grid'],
      [['BracketLeft', 'BracketRight'], 'Previous / next detail tab'],
    ],
  },
  {
    title: 'Tree view',
    items: [
      [['ArrowRight', 'ArrowLeft'], 'Unfold / fold (or step in / out)'],
      [['*'], 'Unfold every linked document below'],
      [['='], 'Unfold all documents like the current one'],
      [['Space'], 'Select the document for copying'],
    ],
  },
  {
    title: 'Tabs & app',
    items: [
      [['alt+KeyT'], 'New tab'],
      [['alt+KeyW'], 'Close tab'],
      [['alt+BracketLeft', 'alt+BracketRight'], 'Previous / next tab'],
      [['alt+Digit1'], 'Go to tab 1 (… up to 9)'],
      [['alt+KeyD'], 'Theme: system → light → dark'],
      [['shift+Slash'], 'This cheat sheet'],
    ],
  },
];

export function ShortcutHelp() {
  const open = useUiStore((s) => s.helpOpen);
  const setOpen = useUiStore((s) => s.setHelpOpen);
  if (!open) return null;
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setOpen(false)} wide>
      <div className="grid gap-6 md:grid-cols-3">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{group.title}</h3>
            <dl className="flex flex-col gap-1.5 text-sm">
              {group.items.map(([keys, what]) => (
                <div key={what} className="flex items-baseline gap-2">
                  <dt className="flex shrink-0 gap-1">
                    {keys.map((k) => (
                      <kbd key={k} className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-200">
                        {comboLabel(k)}
                      </kbd>
                    ))}
                  </dt>
                  <dd className="text-zinc-300">{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="mt-5 text-xs text-zinc-500">
        The browser keeps Ctrl/Cmd+T, +W and +1…9 for its own tabs, so LiteMongo uses Alt for those.
      </p>
    </Modal>
  );
}
