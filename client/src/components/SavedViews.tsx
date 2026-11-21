import { useState } from 'react';
import { defaultDbFromUri } from '../lib/api';
import { parseQueryText, pretty } from '../lib/ejson';
import { useProfile } from '../store/useConnectionStore';
import { useTabStore, type QueryTab, type ViewMode } from '../store/useTabStore';
import { useBlueprints, usePresets, useWorkspaceStore } from '../store/useWorkspaceStore';
import type { QueryPreset } from '../types';
import { Button, Dropdown, inputClass, toast } from './ui';

/**
 * Saved views: a named snapshot of a tab — collection, filter / projection /
 * sort / limit, the joins (linked collections), the view mode, which detail
 * sections are on and the column order. Stored in litemongo.config.json
 * (`queryPresets`), so they travel with the workspace config.
 */

const VIEW_LABEL: Record<ViewMode, string> = { table: 'table', nested: 'master-detail', stack: 'nested table', tree: 'tree' };

function newId(): string {
  return `view-${Math.random().toString(36).slice(2, 8)}`;
}

/** Tab patch that opens a saved view (and runs it when the tab has a connection). */
export function applyViewPatch(tab: QueryTab, preset: QueryPreset, blueprintLevels: QueryPreset['levels'], fallbackDb: string | null): Partial<QueryTab> {
  const levels = preset.levels ?? blueprintLevels ?? [];
  const db = tab.db ?? fallbackDb;
  const patch: Partial<QueryTab> = {
    mode: 'query',
    db,
    collection: preset.collection,
    filter: pretty(preset.filter ?? {}),
    projection: pretty(preset.projection ?? {}),
    sort: pretty(preset.sort ?? {}),
    limit: preset.limit ?? 100,
    blueprintId: preset.levels ? null : (preset.relationBlueprintId ?? null),
    levels,
    presetId: preset.id,
    lastRun: null,
    ...(preset.viewMode ? { viewMode: preset.viewMode } : {}),
    ...(preset.hiddenSections ? { hiddenSections: preset.hiddenSections } : {}),
    ...(preset.shownSections ? { shownSections: preset.shownSections } : {}),
    ...(preset.columns ? { columns: preset.columns } : {}),
    ...(preset.nestedJson !== undefined ? { nestedJson: preset.nestedJson } : {}),
  };
  if (tab.connectionId && db) {
    patch.lastRun = {
      connectionId: tab.connectionId,
      db,
      collection: preset.collection,
      filter: preset.filter ?? {},
      projection: preset.projection ?? {},
      sort: preset.sort ?? {},
      limit: preset.limit ?? 100,
      blueprintId: patch.blueprintId ?? null,
      levels,
      at: Date.now(),
    };
  }
  return patch;
}

/** Dropdown of saved views; picking one opens and runs it in this tab. */
export function ViewPicker({ tab }: { tab: QueryTab }) {
  const presets = usePresets();
  const blueprints = useBlueprints();
  const profile = useProfile(tab.connectionId);
  const updateTab = useTabStore((s) => s.updateTab);
  if (presets.length === 0) return null;
  return (
    <select
      aria-label="Saved views"
      title="Saved views: query + joins + detail sections + columns"
      className={`${inputClass} max-w-64`}
      value={presets.some((p) => p.id === tab.presetId) ? (tab.presetId as string) : ''}
      disabled={!profile}
      onChange={(e) => {
        const preset = presets.find((p) => p.id === e.target.value);
        if (!preset) return;
        const bp = blueprints.find((b) => b.id === preset.relationBlueprintId)?.levels;
        updateTab(tab.id, applyViewPatch(tab, preset, bp, profile ? defaultDbFromUri(profile.uri) : null));
      }}
    >
      <option value="">{profile ? '★ Saved views…' : '★ Saved views (connect first)'}</option>
      {presets.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} — {p.collection}
          {p.levels?.length ? ` ⛓${p.levels.length}` : ''}
        </option>
      ))}
    </select>
  );
}

function suggestName(tab: QueryTab): string {
  const links = tab.levels.map((l) => l.collection);
  return `${tab.collection ?? 'view'}${links.length ? ` + ${links.join(', ')}` : ''}`;
}

/** "Save view": name it and save, or update the view this tab came from. */
export function SaveViewButton({ tab }: { tab: QueryTab }) {
  const presets = usePresets();
  const current = presets.find((p) => p.id === tab.presetId);
  return (
    <Dropdown
      label={<span className="text-sm">★ Save view</span>}
      title="Save this query with its joins, detail sections and columns under a name"
      className="border-zinc-700 bg-zinc-800 px-2.5 py-1 font-medium text-zinc-100 hover:bg-zinc-700"
      width={340}
    >
      {(close) => <SaveViewForm tab={tab} current={current} onDone={close} />}
    </Dropdown>
  );
}

function SaveViewForm({ tab, current, onDone }: { tab: QueryTab; current: QueryPreset | undefined; onDone: () => void }) {
  const savePreset = useWorkspaceStore((s) => s.savePreset);
  const removePreset = useWorkspaceStore((s) => s.removePreset);
  const updateTab = useTabStore((s) => s.updateTab);
  const [name, setName] = useState(current?.name ?? suggestName(tab));

  const snapshot = (id: string): QueryPreset | null => {
    if (!tab.collection) return null;
    try {
      return {
        id,
        name: name.trim() || suggestName(tab),
        collection: tab.collection,
        filter: parseQueryText(tab.filter, 'Filter'),
        projection: parseQueryText(tab.projection, 'Projection'),
        sort: parseQueryText(tab.sort, 'Sort'),
        limit: tab.limit,
        ...(tab.levels.length ? { levels: tab.levels } : {}),
        ...(tab.blueprintId ? { relationBlueprintId: tab.blueprintId } : {}),
        viewMode: tab.viewMode,
        ...(tab.hiddenSections?.length ? { hiddenSections: tab.hiddenSections } : {}),
        ...(tab.shownSections?.length ? { shownSections: tab.shownSections } : {}),
        ...(tab.columns && Object.keys(tab.columns).length ? { columns: tab.columns } : {}),
        ...(tab.nestedJson ? { nestedJson: true } : {}),
      };
    } catch (err) {
      toast((err as Error).message, 'error');
      return null;
    }
  };

  const save = (id: string, verb: string) => {
    const preset = snapshot(id);
    if (!preset) return;
    savePreset(preset);
    updateTab(tab.id, { presetId: preset.id });
    toast(`${verb} view “${preset.name}”`);
    onDone();
  };

  const details = [
    tab.collection,
    tab.levels.length ? `${tab.levels.length} join${tab.levels.length === 1 ? '' : 's'} (${tab.levels.map((l) => l.collection).join(', ')})` : 'no joins',
    VIEW_LABEL[tab.viewMode],
    (tab.hiddenSections?.length ?? 0) + (tab.shownSections?.length ?? 0) > 0 ? 'detail sections' : null,
    tab.columns && Object.keys(tab.columns).length ? 'columns' : null,
  ].filter(Boolean);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (current) save(current.id, 'Updated');
        else save(newId(), 'Saved');
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        Name
        <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
      </label>
      <p className="text-[11px] text-zinc-500">Saves: {details.join(' · ')}, filter / projection / sort / limit.</p>
      <div className="flex flex-wrap gap-1.5">
        {current ? (
          <>
            <Button type="submit" variant="primary">
              Update “{current.name}”
            </Button>
            <Button onClick={() => save(newId(), 'Saved')}>Save as new</Button>
          </>
        ) : (
          <Button type="submit" variant="primary">
            Save
          </Button>
        )}
        {current && (
          <Button
            variant="ghost"
            className="ml-auto text-red-400"
            onClick={() => {
              if (!window.confirm(`Delete saved view “${current.name}”?`)) return;
              removePreset(current.id);
              updateTab(tab.id, { presetId: null });
              onDone();
            }}
          >
            Delete
          </Button>
        )}
      </div>
    </form>
  );
}
