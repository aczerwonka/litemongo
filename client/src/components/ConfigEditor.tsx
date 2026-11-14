import Editor, { type OnMount } from '@monaco-editor/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { copyText, downloadText, readText } from '../lib/clipboard';
import { validateConfigText, type ConfigIssue } from '../lib/configValidation';
import { monaco } from '../lib/monaco';
import { useResolvedTheme } from '../store/useThemeStore';
import { EXAMPLE_CONFIG, useWorkspaceStore } from '../store/useWorkspaceStore';
import type { WorkspaceConfig } from '../types';
import { Button, Modal, toast } from './ui';

/**
 * In-app editor for litemongo.config.json: edit, copy / paste, upload /
 * download, live validation (syntax errors marked in the editor, structural
 * problems listed with their JSON path). Changes apply only on "Apply".
 */

const MODEL_PATH = 'litemongo/litemongo.config.json';
const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export function ConfigEditor({ onClose }: { onClose: () => void }) {
  const config = useWorkspaceStore((s) => s.config);
  const setConfig = useWorkspaceStore((s) => s.setConfig);
  const applied = useMemo(() => pretty(config), [config]);
  const [text, setText] = useState(applied);
  const [debounced, setDebounced] = useState(applied);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const theme = useResolvedTheme();

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text), 250);
    return () => window.clearTimeout(t);
  }, [text]);
  const validation = useMemo(() => validateConfigText(debounced), [debounced]);
  const pending = debounced !== text;
  const dirty = text !== applied;
  const errors = validation.issues.filter((i) => i.severity === 'error');
  const warnings = validation.issues.filter((i) => i.severity === 'warning');

  // Syntax errors as editor markers (squiggle + gutter).
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const markers = validation.issues
      .filter((i) => i.line)
      .map((i) => ({
        severity: monaco.MarkerSeverity.Error,
        message: i.message,
        startLineNumber: i.line as number,
        startColumn: i.column ?? 1,
        endLineNumber: i.line as number,
        endColumn: (i.column ?? 1) + 1,
      }));
    monaco.editor.setModelMarkers(model, 'litemongo-config', markers);
  }, [validation]);

  const replaceText = (next: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model) {
      // Keep it undoable (Ctrl+Z) instead of resetting the model.
      editor.pushUndoStop();
      editor.executeEdits('litemongo', [{ range: model.getFullModelRange(), text: next }]);
      editor.pushUndoStop();
    }
    setText(next);
  };

  const format = () => {
    try {
      replaceText(pretty(JSON.parse(text)));
    } catch {
      toast('Fix the JSON syntax first', 'error');
    }
  };

  const apply = () => {
    const result = validateConfigText(text);
    if (!result.ok) {
      setDebounced(text);
      toast('The config has errors: see the list below the editor', 'error');
      return;
    }
    setConfig(result.parsed as WorkspaceConfig);
    toast(`Workspace config applied: ${(result.parsed as WorkspaceConfig).workspaceName ?? 'unnamed'}`);
  };

  const pasteFromClipboard = async () => {
    const clip = await readText();
    if (clip === null) toast('Clipboard read blocked by the browser: click into the editor and press Ctrl/Cmd+V', 'error');
    else replaceText(clip);
  };

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => document.getElementById('config-apply')?.click());
  };

  const goTo = (issue: ConfigIssue) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (issue.line) {
      editor.revealLineInCenter(issue.line);
      editor.setPosition({ lineNumber: issue.line, column: issue.column ?? 1 });
    } else {
      // Structural issue: jump to the last key of its path.
      const key = issue.path.split(/[.[\]]/).filter((s) => s && !/^\d+$/.test(s)).pop();
      const match = key ? editor.getModel()?.findMatches(`"${key}"`, false, false, true, null, false)[0] : undefined;
      if (match) {
        editor.revealRangeInCenter(match.range);
        editor.setSelection(match.range);
      }
    }
    editor.focus();
  };

  const close = () => {
    if (dirty && !window.confirm('Discard the unapplied changes to the config?')) return;
    onClose();
  };

  return (
    <Modal
      title="Workspace config (litemongo.config.json)"
      onClose={close}
      size="full"
      footer={
        <>
          <span className="mr-auto self-center text-xs text-zinc-500">
            {dirty ? 'Unapplied changes · Ctrl/Cmd+S applies' : 'In sync with the active config'}
          </span>
          <Button variant="ghost" onClick={() => replaceText(applied)} disabled={!dirty}>
            Revert
          </Button>
          <Button id="config-apply" variant="primary" onClick={apply} disabled={!dirty || pending || !validation.ok}>
            Apply
          </Button>
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={async () => {
              if (await copyText(text)) toast('Config copied to clipboard');
              else toast('Clipboard blocked: use Download instead', 'error');
            }}
          >
            ⧉ Copy
          </Button>
          <Button onClick={pasteFromClipboard} title="Replace the editor content with the clipboard">
            ⎘ Paste
          </Button>
          <Button onClick={format}>{'{ }'} Format</Button>
          <Button onClick={() => downloadText('litemongo.config.json', text)}>⇩ Download</Button>
          <Button onClick={() => fileRef.current?.click()}>⇧ Upload…</Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) replaceText(await file.text());
              e.target.value = '';
            }}
          />
          <Button
            variant="ghost"
            onClick={() => {
              if (window.confirm('Load the bundled example config into the editor? (Apply to use it)')) replaceText(pretty(EXAMPLE_CONFIG));
            }}
          >
            Load example
          </Button>
          <span className={`ml-auto text-sm ${pending ? 'text-zinc-500' : errors.length ? 'text-red-400' : warnings.length ? 'text-amber-300' : 'text-emerald-400'}`}>
            {pending
              ? 'Validating…'
              : errors.length
                ? `✕ ${errors.length} error${errors.length === 1 ? '' : 's'}${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}`
                : warnings.length
                  ? `⚠ Valid, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
                  : '✓ Valid'}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded border border-zinc-800">
          <Editor
            path={MODEL_PATH}
            defaultLanguage="json"
            defaultValue={applied}
            theme={theme === 'dark' ? 'vs-dark' : 'vs'}
            onChange={(v) => setText(v ?? '')}
            onMount={handleMount}
            loading={<div className="p-2 text-xs text-zinc-500">Loading editor…</div>}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              tabSize: 2,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              folding: true,
              ariaLabel: 'litemongo.config.json',
            }}
          />
        </div>
        {validation.issues.length > 0 && !pending && (
          <ul className="max-h-36 shrink-0 overflow-auto rounded border border-zinc-800 bg-zinc-950 text-xs" aria-label="Validation issues">
            {validation.issues.map((issue, i) => (
              <li key={i}>
                <button type="button" onClick={() => goTo(issue)} className="flex w-full gap-2 px-2 py-1 text-left hover:bg-zinc-900">
                  <span className={issue.severity === 'error' ? 'text-red-400' : 'text-amber-300'}>{issue.severity === 'error' ? '✕' : '⚠'}</span>
                  <span className="font-mono text-zinc-400">{issue.line ? `line ${issue.line}` : issue.path}</span>
                  <span className="text-zinc-200">{issue.message}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
