import Editor, { type OnMount } from '@monaco-editor/react';
import { useRef } from 'react';
import { useSchemaAutocomplete, type CompletionContext } from '../hooks/useSchemaAutocomplete';
import { monaco } from '../lib/monaco';
import { useResolvedTheme } from '../store/useThemeStore';

const editors = new Map<string, monaco.editor.IStandaloneCodeEditor>();

/** Move keyboard focus into the editor mounted with this `path` (keyboard shortcuts). */
export function focusEditor(path: string): void {
  editors.get(path)?.focus();
}

/** Small Monaco instance for filter / projection / sort. Ctrl/Cmd+Enter runs the query. */
export function JsonEditor({
  path,
  value,
  onChange,
  onRun,
  label,
  completion,
  language = 'json',
  actions,
}: {
  /** Unique model path so each tab keeps its own undo history. */
  path: string;
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  label: string;
  /** Schema-driven autocomplete context (collection + editor kind). */
  completion?: CompletionContext | undefined;
  /** "javascript" for free-query scripts. */
  language?: 'json' | 'javascript';
  /** Extra controls in the label bar (right side). */
  actions?: React.ReactNode;
}) {
  useSchemaAutocomplete(path, completion);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const theme = useResolvedTheme();

  const handleMount: OnMount = (editor) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRunRef.current());
    editors.set(path, editor);
    editor.onDidDispose(() => {
      if (editors.get(path) === editor) editors.delete(path);
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded border border-zinc-800">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-500">
        <span>{label}</span>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          path={path}
          defaultLanguage={language}
          value={value}
          theme={theme === 'dark' ? 'vs-dark' : 'vs'}
          onChange={(v) => onChange(v ?? '')}
          onMount={handleMount}
          loading={<div className="p-2 text-xs text-zinc-500">Loading editor…</div>}
          options={{
            minimap: { enabled: false },
            lineNumbers: language === 'javascript' ? 'on' : 'off',
            lineNumbersMinChars: 3,
            glyphMargin: false,
            folding: language === 'javascript',
            fontSize: 13,
            tabSize: 2,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
            padding: { top: 6, bottom: 6 },
            ariaLabel: label,
            quickSuggestions: { other: true, strings: true, comments: false },
            suggest: { showWords: false },
          }}
        />
      </div>
    </div>
  );
}
