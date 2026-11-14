import { useEffect, useRef, useState } from 'react';
import { useHotkeys } from '../hooks/useHotkeys';
import { defaultDbFromUri } from '../lib/api';
import type { ShellResult, WorkerMessage } from '../lib/shell/protocol';
import ShellWorker from '../lib/shell/worker?worker';
import { contextFor, useProfile } from '../store/useConnectionStore';
import { usePaneSize } from '../store/useLayoutStore';
import { useTabStore, type QueryTab } from '../store/useTabStore';
import { useSchemas } from '../store/useWorkspaceStore';
import { DataViewer } from './DataViewer';
import { focusEditor, JsonEditor } from './JsonEditor';
import { Splitter } from './Splitter';
import { Button, inputClass, useServerInfo } from './ui';

/**
 * Free-query mode: a mongosh-like script (`db.policies.find({ … }).sort(…)`,
 * loops, print()) executed in a Web Worker in this browser. Iterable results
 * (cursors, arrays, documents) show in the simplified Tree / Table viewer;
 * print() / printjson() / console.log() output and other values go to the console.
 */

interface ConsoleLine {
  id: number;
  level: 'log' | 'warn' | 'error' | 'info' | 'result';
  text: string;
}

interface RunState {
  running: boolean;
  startedAt: number | null;
  ms: number | null;
  ops: number;
  result: ShellResult | null;
  errorLine: number | null;
}

const EXAMPLE = `// Free query: mongosh-style. Ctrl/Cmd+Enter runs, the last expression is shown.
// db.policies2.find({ status: "ACTIVE", covers: { $elemMatch: { code: "COVER_AC" } } }).limit(20)

const n = db.policies2.countDocuments({ status: "ACTIVE" });
print("active policies2:", n);

db.policies2.find({ status: "ACTIVE" }).sort({ issueDate: -1 }).limit(50)
`;

let lineId = 0;

export function ScriptWorkspace({ tab }: { tab: QueryTab }) {
  const updateTab = useTabStore((s) => s.updateTab);
  const profile = useProfile(tab.connectionId);
  const forceReadOnly = useServerInfo().data?.forceReadOnly ?? false;
  const schemas = useSchemas();
  const editorHeight = usePaneSize('script.editor', 220);
  const consoleHeight = usePaneSize('script.console', 160);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [run, setRun] = useState<RunState>({ running: false, startedAt: null, ms: null, ops: 0, result: null, errorLine: null });
  const [view, setView] = useState<'table' | 'tree'>(tab.viewMode === 'tree' ? 'tree' : 'table');
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(Date.now());
  const workerRef = useRef<Worker | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  const db = tab.db ?? (profile ? defaultDbFromUri(profile.uri) : null);
  const conn = profile ? contextFor(profile, forceReadOnly) : undefined;
  const editorPath = `${tab.id}/script.js`;

  useEffect(() => () => workerRef.current?.terminate(), []);
  // A brand-new script tab starts with a short example.
  useEffect(() => {
    if (!tab.script) updateTab(tab.id, { script: EXAMPLE });
  }, [tab.id]);
  useEffect(() => {
    if (!run.running) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [run.running]);
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const push = (level: ConsoleLine['level'], text: string) =>
    setLines((l) => [...l.slice(-1999), { id: ++lineId, level, text }]);

  const stop = (reason = 'Stopped') => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setRun((r) => ({ ...r, running: false, ms: r.startedAt ? Date.now() - r.startedAt : null }));
    push('warn', reason);
  };

  const execute = () => {
    if (!conn || !db || run.running) return;
    workerRef.current?.terminate();
    const worker = new ShellWorker();
    workerRef.current = worker;
    const startedAt = Date.now();
    setNow(startedAt);
    setSelection(new Set());
    setRun({ running: true, startedAt, ms: null, ops: 0, result: null, errorLine: null });
    push('info', `› run on ${db}${conn.readOnly ? ' (read-only)' : ''}`);
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'print':
          push(msg.level, msg.text);
          break;
        case 'op':
          setRun((r) => ({ ...r, ops: r.ops + 1 }));
          break;
        case 'done':
          setRun((r) => ({ ...r, running: false, ms: msg.ms, result: msg.result }));
          if (msg.result.kind === 'value') push('result', msg.result.text);
          else if (msg.result.kind === 'docs')
            push('info', `${msg.result.label}: ${msg.result.docs.length}${msg.result.hasMore ? '+' : ''} document(s) in the result view · ${msg.ms} ms`);
          else push('info', `done · ${msg.ms} ms`);
          worker.terminate();
          workerRef.current = null;
          break;
        case 'error':
          setRun((r) => ({ ...r, running: false, ms: Date.now() - startedAt, errorLine: msg.line ?? null }));
          push('error', msg.line ? `${msg.message} (line ${msg.line})` : msg.message);
          worker.terminate();
          workerRef.current = null;
          break;
      }
    };
    worker.onerror = (e) => {
      setRun((r) => ({ ...r, running: false }));
      push('error', e.message || 'Script worker crashed');
    };
    worker.postMessage({ type: 'run', script: tab.script, db, uri: conn.uri, readOnly: conn.readOnly, displayLimit: tab.limit });
  };

  useHotkeys({
    'mod+Enter': execute,
    'alt+KeyF': () => focusEditor(editorPath),
  });

  const result = run.result;
  const docs = result?.kind === 'docs' ? result.docs : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ModeSwitch tab={tab} />
        <span className="font-mono text-sm text-zinc-300">
          db = <span className="text-zinc-50">{db ?? '(no database)'}</span>
        </span>
        <label className="flex items-center gap-1 text-sm text-zinc-400" title="Documents shown when the result is a cursor without .limit()">
          Show
          <input
            type="number"
            min={1}
            max={5000}
            className={`${inputClass} w-20`}
            value={tab.limit}
            onChange={(e) => updateTab(tab.id, { limit: Math.min(Math.max(Number(e.target.value) || 1, 1), 5000) })}
          />
        </label>
        {conn?.readOnly && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">🔒 writes blocked</span>}
        <div className="ml-auto flex gap-2">
          {run.running && (
            <Button variant="danger" onClick={() => stop()}>
              ■ Stop
            </Button>
          )}
          <Button variant="primary" onClick={execute} disabled={run.running || !db || !tab.script.trim()} title="Run script (Ctrl/Cmd+Enter)">
            {run.running ? `Running… ${((now - (run.startedAt ?? now)) / 1000).toFixed(1)} s` : '▶ Run'}
          </Button>
        </div>
      </div>

      <div className="grid shrink-0" style={{ height: editorHeight }}>
        <JsonEditor
          path={editorPath}
          label="Script (JavaScript, mongosh-style: db.collection.find(…), print(…))"
          language="javascript"
          value={tab.script}
          onChange={(script) => updateTab(tab.id, { script })}
          onRun={execute}
          completion={{ collection: null, kind: 'script', conn, db }}
          actions={
            run.errorLine ? <span className="text-red-400">error on line {run.errorLine}</span> : undefined
          }
        />
      </div>
      <Splitter sizeKey="script.editor" size={editorHeight} min={80} label="Resize script editor" />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className="flex overflow-hidden rounded border border-zinc-700" role="group" aria-label="Result view">
          {(['table', 'tree'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={view === m}
              onClick={() => setView(m)}
              className={`px-2.5 py-1 capitalize ${view === m ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800'}`}
            >
              {m}
            </button>
          ))}
        </div>
        {result?.kind === 'docs' && (
          <span className="text-zinc-400">
            {result.label} · {result.docs.length} document{result.docs.length === 1 ? '' : 's'}
            {result.hasMore && ' (more available: add .limit() or raise "Show")'}
            {run.ms !== null && ` · ${run.ms} ms`} · {run.ops} server call{run.ops === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded border border-zinc-800">
        {docs ? (
          <DataViewer
            collection={result?.kind === 'docs' ? result.label.split('.')[0] ?? 'result' : 'result'}
            docs={docs}
            nodes={null}
            viewMode={view}
            schemas={schemas}
            levels={[]}
            selection={selection}
            onSelectionChange={setSelection}
            hiddenSections={[]}
            onHiddenSectionsChange={() => {}}
          />
        ) : (
          <div className="p-4 text-sm text-zinc-500">
            {run.running
              ? 'Running…'
              : result?.kind === 'value'
                ? 'The result is not iterable: see the console below.'
                : 'Run the script (Ctrl/Cmd+Enter). Cursors, arrays and documents returned by the last expression appear here.'}
          </div>
        )}
      </div>

      <Splitter sizeKey="script.console" size={consoleHeight} min={60} label="Resize console" />
      <div className="flex shrink-0 flex-col overflow-hidden rounded border border-zinc-800" style={{ height: consoleHeight }}>
        <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-500">
          <span>Console</span>
          <button type="button" className="ml-auto hover:text-zinc-200" onClick={() => setLines([])}>
            Clear
          </button>
        </div>
        <div ref={consoleRef} className="min-h-0 flex-1 overflow-auto bg-zinc-950 px-2 py-1 font-mono text-xs" role="log" aria-label="Script output">
          {lines.length === 0 && <div className="text-zinc-600">print(), printjson() and console.log() output appears here.</div>}
          {lines.map((l) => (
            <pre
              key={l.id}
              className={`whitespace-pre-wrap break-words ${
                l.level === 'error'
                  ? 'text-red-400'
                  : l.level === 'warn'
                    ? 'text-amber-300'
                    : l.level === 'info'
                      ? 'text-zinc-500'
                      : l.level === 'result'
                        ? 'text-emerald-300'
                        : 'text-zinc-200'
              }`}
            >
              {l.text}
            </pre>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Query builder ⇄ free-query script toggle. */
export function ModeSwitch({ tab }: { tab: QueryTab }) {
  const updateTab = useTabStore((s) => s.updateTab);
  const toScript = () => {
    const patch: Partial<QueryTab> = { mode: 'script' };
    // Seed the script from the current query the first time.
    if (!tab.script.trim() && tab.collection) {
      const coll = /^[A-Za-z_$][\w$]*$/.test(tab.collection) ? `db.${tab.collection}` : `db.getCollection(${JSON.stringify(tab.collection)})`;
      const sort = tab.sort.trim() && tab.sort.trim() !== '{}' ? `.sort(${tab.sort.trim()})` : '';
      const proj = tab.projection.trim() && tab.projection.trim() !== '{}' ? `, ${tab.projection.trim()}` : '';
      patch.script = `${coll}.find(${tab.filter.trim() || '{}'}${proj})${sort}.limit(${tab.limit})\n`;
    }
    updateTab(tab.id, patch);
  };
  return (
    <div className="flex overflow-hidden rounded border border-zinc-700 text-sm" role="group" aria-label="Query mode">
      <button
        type="button"
        aria-pressed={tab.mode !== 'script'}
        onClick={() => updateTab(tab.id, { mode: 'query' })}
        className={`px-2.5 py-1 ${tab.mode !== 'script' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800'}`}
        title="Filter / projection / sort builder with relations"
      >
        Query
      </button>
      <button
        type="button"
        aria-pressed={tab.mode === 'script'}
        onClick={toScript}
        className={`px-2.5 py-1 ${tab.mode === 'script' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800'}`}
        title="Free query: mongosh-style script (db.policies.find(…), print(…))"
      >
        Script
      </button>
    </div>
  );
}
