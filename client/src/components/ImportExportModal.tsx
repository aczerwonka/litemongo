import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { create } from 'zustand';
import { api, defaultDbFromUri } from '../lib/api';
import { readText } from '../lib/clipboard';
import { contextFor, ENV_STYLES, isLockedEnv, useProfile } from '../store/useConnectionStore';
import { useActiveTab } from '../store/useTabStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import type { RemapSummary } from '../types';
import { ConfigEditor } from './ConfigEditor';
import { Button, ErrorBox, Field, inputClass, Modal, toast, useServerInfo } from './ui';

type TransferState =
  | { mode: 'paste' }
  | { mode: 'copy'; text: string; summary: string }
  | { mode: 'config' };

export const useTransferModal = create<{
  state: TransferState | null;
  open: (state: TransferState) => void;
  close: () => void;
}>((set) => ({
  state: null,
  open: (state) => set({ state }),
  close: () => set({ state: null }),
}));

export function ImportExportModal() {
  const state = useTransferModal((s) => s.state);
  const close = useTransferModal((s) => s.close);
  if (!state) return null;
  if (state.mode === 'copy') return <CopyFallback text={state.text} summary={state.summary} onClose={close} />;
  if (state.mode === 'config') return <ConfigSync onClose={close} />;
  return <PasteData onClose={close} />;
}

// ---------------------------------------------------------------------------
// Copy fallback (clipboard API unavailable, e.g. plain-http jump host)
// ---------------------------------------------------------------------------

function CopyFallback({ text, summary, onClose }: { text: string; summary: string; onClose: () => void }) {
  return (
    <Modal title="Copy EJSON bundle" onClose={onClose} wide>
      <p className="mb-2 text-sm text-zinc-400">
        The browser blocked clipboard access ({summary}). Select the text below and copy it manually.
      </p>
      <textarea
        readOnly
        className={`${inputClass} h-[60vh] w-full font-mono text-xs`}
        value={text}
        onFocus={(e) => e.currentTarget.select()}
        autoFocus
      />
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Paste data with the Intelligent ID Remapper preview
// ---------------------------------------------------------------------------

function PasteData({ onClose }: { onClose: () => void }) {
  const tab = useActiveTab();
  const profile = useProfile(tab.connectionId);
  const config = useWorkspaceStore((s) => s.config);
  const forceReadOnly = useServerInfo().data?.forceReadOnly ?? false;
  const queryClient = useQueryClient();
  const [bundle, setBundle] = useState('');
  const [remap, setRemap] = useState(true);
  const [targetDb, setTargetDb] = useState(tab.db ?? (profile ? defaultDbFromUri(profile.uri) ?? '' : ''));

  const transferConfig = { schemas: config.schemas, renumberingRules: config.renumberingRules };

  const preview = useMutation({
    mutationFn: () => api.dryRun({ bundle, remap, ...transferConfig }),
  });

  const paste = useMutation({
    mutationFn: () => {
      if (!profile || !preview.data) throw new Error('Preview first');
      // Insert exactly what the preview showed: the remapped bundle, without remapping again.
      return api.paste(contextFor(profile, forceReadOnly), {
        bundle: remap ? preview.data.preview : bundle,
        remap: false,
        db: targetDb,
      });
    },
    onSuccess: (res) => {
      toast(`Inserted ${res.result.inserted} document(s) into ${res.result.targetDb}`);
      void queryClient.invalidateQueries({ queryKey: ['run'] });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
    },
  });

  const resetPreview = () => {
    preview.reset();
    paste.reset();
  };

  const locked = !profile || forceReadOnly || profile.readOnly || isLockedEnv(profile.env);
  const style = profile ? ENV_STYLES[profile.env] : undefined;

  const doPaste = () => {
    if (!profile || !preview.data) return;
    const n = preview.data.summary.totals.documents;
    if (profile.env === 'test') {
      const ok = window.confirm(`Insert ${n} document(s) into "${targetDb}" on ${profile.name} (${style?.label})?`);
      if (!ok) return;
    }
    paste.mutate();
  };

  const pasteFromClipboard = async () => {
    const text = await readText();
    if (text === null) toast('Clipboard read blocked by the browser: paste with Ctrl/Cmd+V instead', 'error');
    else {
      setBundle(text);
      resetPreview();
    }
  };

  return (
    <Modal
      title="Paste EJSON bundle"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={() => preview.mutate()} disabled={!bundle.trim() || preview.isPending}>
            {preview.isPending ? 'Previewing…' : 'Preview (dry run)'}
          </Button>
          <Button
            variant={profile?.env === 'test' ? 'danger' : 'primary'}
            onClick={doPaste}
            disabled={locked || !preview.data || !targetDb.trim() || paste.isPending || paste.isSuccess}
            title={locked ? 'Connection is read-only' : undefined}
          >
            {locked ? '🔒 Read-only' : paste.isPending ? 'Inserting…' : `Insert ${preview.data?.summary.totals.documents ?? ''} documents`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Target connection">
            <div className={`rounded px-2 py-1 text-sm text-white ${style?.banner ?? 'bg-zinc-800'}`}>
              {profile ? `${profile.name}${locked ? ' 🔒' : ''}` : 'none'}
            </div>
          </Field>
          <Field label="Target database">
            <input className={`${inputClass} font-mono`} value={targetDb} onChange={(e) => setTargetDb(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 pb-1 text-sm">
            <input
              type="checkbox"
              checked={remap}
              onChange={(e) => {
                setRemap(e.target.checked);
                resetPreview();
              }}
            />
            Renumber / remap IDs (keeps references linked)
          </label>
          <Button className="mb-0.5 ml-auto" onClick={pasteFromClipboard}>
            Read clipboard
          </Button>
        </div>
        <textarea
          className={`${inputClass} h-40 w-full font-mono text-xs`}
          placeholder='{"format": "litemongo-bundle", "version": 1, "collections": { … }}'
          value={bundle}
          spellCheck={false}
          onChange={(e) => {
            setBundle(e.target.value);
            resetPreview();
          }}
        />
        {locked && profile && (
          <div className="text-sm text-amber-300">
            This connection is read-only{forceReadOnly ? ' (enforced by the server)' : ''}. You can preview, but inserting is
            disabled. Unlock it in the environment banner.
          </div>
        )}
        <ErrorBox error={preview.error} />
        <ErrorBox error={paste.error} />
        {preview.data && <RemapPreview summary={preview.data.summary} />}
        {paste.data && (
          <div className="rounded border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-100">
            Inserted {paste.data.result.inserted}, failed {paste.data.result.failed} in {paste.data.result.targetDb}.
            {Object.entries(paste.data.result.collections).map(([c, r]) =>
              r.errors.length ? (
                <div key={c} className="mt-1 text-red-200">
                  {c}: {r.errors.join('; ')}
                </div>
              ) : null,
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function RemapPreview({ summary }: { summary: RemapSummary }) {
  const [show, setShow] = useState<'ids' | 'links' | null>(null);
  const undeclared = summary.links.filter((l) => !l.declared).length;
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-sm">
        <thead className="text-left text-zinc-400">
          <tr>
            <th className="py-1">Collection</th>
            <th>Documents</th>
            <th>Root _id remapped</th>
            <th>Nested IDs remapped</th>
            <th>Foreign keys rewritten</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {Object.entries(summary.collections).map(([c, s]) => (
            <tr key={c} className="border-t border-zinc-800">
              <td className="py-1">{c}</td>
              <td>{s.documents}</td>
              <td>{s.rootIdsRemapped}</td>
              <td>{s.nestedIdsRemapped}</td>
              <td>{s.foreignKeysRewritten}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {summary.warnings.length > 0 && (
        <ul className="rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          {summary.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {undeclared > 0 && (
        <div className="text-sm text-amber-300">
          ⚠ {undeclared} rewritten value(s) are on paths not declared as foreign keys. Review them under “Links”.
        </div>
      )}
      {summary.remapped && (
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setShow(show === 'ids' ? null : 'ids')}>
            {show === 'ids' ? '▾' : '▸'} ID map ({summary.idMap.length})
          </Button>
          <Button variant="ghost" onClick={() => setShow(show === 'links' ? null : 'links')}>
            {show === 'links' ? '▾' : '▸'} Links ({summary.links.length})
          </Button>
        </div>
      )}
      {show === 'ids' && (
        <div className="max-h-64 overflow-auto rounded border border-zinc-800 font-mono text-xs">
          {summary.idMap.map((m, i) => (
            <div key={i} className="grid grid-cols-[14rem_1fr_1fr] gap-2 border-b border-zinc-900 px-2 py-0.5">
              <span className="text-zinc-400">{m.collection}.{m.path}</span>
              <span className="truncate text-zinc-500">{m.old}</span>
              <span className="truncate text-emerald-300">→ {m.new}</span>
            </div>
          ))}
        </div>
      )}
      {show === 'links' && (
        <div className="max-h-64 overflow-auto rounded border border-zinc-800 font-mono text-xs">
          {summary.links.map((l, i) => (
            <div key={i} className="grid grid-cols-[14rem_10rem_1fr] gap-2 border-b border-zinc-900 px-2 py-0.5">
              <span className={l.declared ? 'text-zinc-400' : 'text-amber-300'}>
                {l.collection}.{l.path}
                {!l.declared && ' ⚠'}
              </span>
              <span className="truncate text-zinc-500">→ {l.references}</span>
              <span className="truncate text-emerald-300">{l.new}</span>
            </div>
          ))}
        </div>
      )}
      {summary.truncatedLists && <div className="text-xs text-zinc-500">Lists truncated to 1000 entries.</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace config (litemongo.config.json) 1-click sync
// ---------------------------------------------------------------------------

function ConfigSync({ onClose }: { onClose: () => void }) {
  return <ConfigEditor onClose={onClose} />;
}
