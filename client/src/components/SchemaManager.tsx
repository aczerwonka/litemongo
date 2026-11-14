import { Fragment, useMemo, useState } from 'react';
import { useCollectionNames } from '../hooks/useCollectionInfo';
import { api, defaultDbFromUri } from '../lib/api';
import {
  childMap,
  FIELD_TYPES,
  fieldMapOf,
  flattenFields,
  inferFields,
  isUnderPath,
  mergeFields,
  withField,
  withFieldPatch,
  withoutField,
  type FieldDef,
  type FieldMap,
  type FlatField,
} from '../lib/schema';
import { contextFor, useProfile } from '../store/useConnectionStore';
import { useActiveTab } from '../store/useTabStore';
import { useUiStore } from '../store/useUiStore';
import { useSchemas, useWorkspaceStore } from '../store/useWorkspaceStore';
import type { CollectionSchema } from '../types';
import { Button, inputClass, Modal, toast, useServerInfo } from './ui';

/**
 * Schema Manager: documents which fields to expect on which object, level by
 * level (document → embedded arrays / objects → their items), plus each field's
 * role: identifier (renumbered on paste), domain code (never remapped), reference
 * to another collection, allowed values.
 *
 * MongoDB 8 documents none of this itself; "Sample data" seeds the tree from real
 * documents so only the meaning has to be filled in by hand. Everything is stored
 * in `schemas` of litemongo.config.json and drives column order, autocomplete,
 * link suggestions, the ID remapper and the MCP endpoint.
 */

/** Default schema sample: first / last N by _id plus N random documents. */
const SAMPLE = { first: 10, last: 10, random: 10 };

const cellInput =
  'w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-[13px] text-zinc-200 outline-none hover:border-zinc-700 focus:border-emerald-500 focus:bg-zinc-950';

export function SchemaManager() {
  const open = useUiStore((s) => s.schemaOpen);
  if (!open) return null;
  return <SchemaDialog />;
}

function SchemaDialog() {
  const close = useUiStore((s) => s.closeSchema);
  const initial = useUiStore((s) => s.schemaFor);
  const tab = useActiveTab();
  const profile = useProfile(tab.connectionId);
  const db = tab.db ?? (profile ? defaultDbFromUri(profile.uri) : null);
  const schemas = useSchemas();
  const dbCollections = useCollectionNames(profile, db);
  const names = useMemo(() => [...new Set([...Object.keys(schemas), ...dbCollections])].sort(), [schemas, dbCollections]);
  const [selected, setSelected] = useState<string | null>(initial ?? tab.collection ?? names[0] ?? null);
  const [newName, setNewName] = useState('');
  const updateSchema = useWorkspaceStore((s) => s.updateSchema);

  return (
    <Modal title="Schema" onClose={close} size="full">
      <div className="flex h-full min-h-0 gap-4">
        <nav className="flex w-52 shrink-0 flex-col gap-2 border-r border-zinc-800 pr-3" aria-label="Collections">
          <ul className="min-h-0 flex-1 overflow-auto">
            {names.map((name) => {
              const count = flattenFields(fieldMapOf(schemas[name])).length;
              return (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => setSelected(name)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-sm ${name === selected ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'}`}
                  >
                    <span className="truncate">{name}</span>
                    <span className={`ml-auto text-xs ${count ? 'text-emerald-400' : 'text-zinc-600'}`}>{count || '—'}</span>
                  </button>
                </li>
              );
            })}
            {names.length === 0 && <li className="px-2 text-sm text-zinc-500">No collections yet.</li>}
          </ul>
          <form
            className="flex gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              if (!name) return;
              if (!schemas[name]) updateSchema(name, (s) => s);
              setSelected(name);
              setNewName('');
            }}
          >
            <input
              className={`${inputClass} min-w-0 flex-1 font-mono`}
              placeholder="collection name"
              aria-label="New collection schema"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Button type="submit" disabled={!newName.trim()}>
              +
            </Button>
          </form>
        </nav>
        <div className="min-h-0 min-w-0 flex-1">
          {selected ? (
            <CollectionEditor key={selected} collection={selected} db={db} canScan={!!profile && !!db && dbCollections.includes(selected)} />
          ) : (
            <p className="text-sm text-zinc-500">Pick a collection on the left to document its fields.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CollectionEditor({ collection, db, canScan }: { collection: string; db: string | null; canScan: boolean }) {
  const schema = useSchemas()[collection] ?? EMPTY_SCHEMA;
  const allSchemas = useSchemas();
  const updateSchema = useWorkspaceStore((s) => s.updateSchema);
  const removeSchema = useWorkspaceStore((s) => s.removeSchema);
  const tab = useActiveTab();
  const profile = useProfile(tab.connectionId);
  const forceReadOnly = useServerInfo().data?.forceReadOnly ?? false;
  const [coverage, setCoverage] = useState<Record<string, number> | null>(null);
  const [scanned, setScanned] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [sample, setSample] = useState(SAMPLE);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const fields = fieldMapOf(schema);
  const flat = useMemo(() => flattenFields(fields), [fields]);
  const visible = flat.filter((f) => ![...collapsed].some((c) => f.configPath !== c && isUnderPath(f.configPath, c)));
  const topLevel = flat.filter((f) => f.level === 1 && !childMap(f.def));

  const isContainer = (f: FlatField) => f.def.type === 'array' || f.def.type === 'object' || !!childMap(f.def);
  /** Expanded containers whose last visible row is `visible[i]`, innermost first: their "add field" rows go right after it. */
  const closingAfter = (i: number): FlatField[] => {
    const row = visible[i] as FlatField;
    const next = visible[i + 1];
    const open = flat.filter(
      (c) => isContainer(c) && !collapsed.has(c.configPath) && isUnderPath(row.configPath, c.configPath) && !(next && isUnderPath(next.configPath, c.configPath)),
    );
    return open.sort((a, b) => b.level - a.level);
  };

  /** Reference targets offered for "References": every documented identifier in other collections. */
  const referenceTargets = useMemo(() => {
    const out: string[] = [];
    for (const [name, s] of Object.entries(allSchemas)) {
      if (name === collection) continue;
      for (const path of s.idPaths ?? ['_id']) out.push(`${name}.${path}`);
    }
    return out;
  }, [allSchemas, collection]);

  const setFields = (next: FieldMap) => updateSchema(collection, (s) => ({ ...s, coreFields: next }));
  const patch = (key: string[], p: Partial<FieldDef>) => setFields(withFieldPatch(fields, key, p));

  const toggleList = (list: 'idPaths' | 'protectedCodePaths', path: string) =>
    updateSchema(collection, (s) => {
      const current = s[list] ?? [];
      const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
      return { ...s, [list]: next };
    });

  const setReference = (path: string, target: string) =>
    updateSchema(collection, (s) => {
      const foreignKeys = { ...s.foreignKeys };
      if (target.trim()) foreignKeys[path] = target.trim();
      else delete foreignKeys[path];
      return { ...s, foreignKeys };
    });

  const remove = (f: FlatField) =>
    updateSchema(collection, (s) => ({
      ...s,
      coreFields: withoutField(fields, f.key),
      idPaths: s.idPaths?.filter((p) => !isUnderPath(p, f.configPath)),
      protectedCodePaths: s.protectedCodePaths?.filter((p) => !isUnderPath(p, f.configPath)),
      foreignKeys: Object.fromEntries(Object.entries(s.foreignKeys ?? {}).filter(([p]) => !isUnderPath(p, f.configPath))),
    }));

  const scan = async () => {
    if (!profile || !db) return;
    setScanning(true);
    try {
      const res = await api.sample(contextFor(profile, forceReadOnly), { db, collection, ...sample });
      const inferred = inferFields(res.documents);
      const merged = mergeFields(fields, inferred.fields);
      updateSchema(collection, (s) => ({ ...s, coreFields: merged.fields, idPaths: s.idPaths ?? ['_id'] }));
      setCoverage(inferred.coverage);
      setScanned(res.documents.length);
      toast(
        res.documents.length === 0
          ? `${collection} is empty — nothing to scan`
          : `Sampled ${res.documents.length} document${res.documents.length === 1 ? '' : 's'} (first ${res.counts.first}, last ${res.counts.last}, random ${res.counts.random}): ${merged.added} new field${merged.added === 1 ? '' : 's'}`,
      );
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-mono text-base font-semibold text-zinc-50">{collection}</h3>
        <label className="flex items-center gap-1 text-sm text-zinc-400">
          Badge
          <select
            className={`${inputClass} font-mono`}
            title="Field shown as the [badge] for documents of this collection"
            value={schema.displayBadgeField ?? ''}
            onChange={(e) =>
              updateSchema(collection, (s) => {
                const next = { ...s };
                if (e.target.value) next.displayBadgeField = e.target.value;
                else delete next.displayBadgeField;
                return next;
              })
            }
          >
            <option value="">none</option>
            {[...new Set([...(schema.displayBadgeField ? [schema.displayBadgeField] : []), ...topLevel.map((f) => f.configPath)])].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <fieldset className="flex items-center gap-1 text-xs text-zinc-400" title="Sample: the first and last documents by _id plus random ones ($sample)">
            <legend className="sr-only">Sample size</legend>
            {(
              [
                ['first', 'First'],
                ['last', 'Last'],
                ['random', 'Random'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1">
                {label}
                <input
                  type="number"
                  min={0}
                  max={500}
                  className={`${inputClass} w-14 px-1 py-0.5 text-xs`}
                  value={sample[key]}
                  onChange={(e) => setSample((s) => ({ ...s, [key]: Math.min(Math.max(Number(e.target.value) || 0, 0), 500) }))}
                />
              </label>
            ))}
          </fieldset>
          <Button
            onClick={scan}
            disabled={!canScan || scanning || sample.first + sample.last + sample.random === 0}
            title={
              canScan
                ? `Sample the first ${sample.first} and last ${sample.last} documents by _id plus ${sample.random} random ones, and add the fields they carry`
                : 'Connect to a database that has this collection to scan it'
            }
          >
            {scanning ? 'Sampling…' : '⟳ Sample data'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              if (window.confirm(`Remove the schema of "${collection}" from the workspace config?`)) removeSchema(collection);
            }}
          >
            🗑 Remove
          </Button>
        </div>
      </div>
      <input
        key={`desc:${schema.description ?? ''}`}
        className={`${inputClass} w-full`}
        placeholder="What this collection holds…"
        aria-label="Collection description"
        defaultValue={schema.description ?? ''}
        onBlur={(e) => {
          const description = e.target.value.trim();
          if (description !== (schema.description ?? '')) updateSchema(collection, (s) => ({ ...s, description }));
        }}
      />

      <div className="min-h-0 flex-1 overflow-auto rounded border border-zinc-800">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-zinc-900 text-left text-xs text-zinc-400">
            <tr>
              <th className="px-2 py-1.5 font-semibold">Field</th>
              <th className="w-28 px-2 py-1.5 font-semibold">Type</th>
              <th className="w-36 px-2 py-1.5 font-semibold" title="ID: gets a fresh value when pasted with remapping. Code: shared domain code, never remapped.">
                Role
              </th>
              <th className="w-48 px-2 py-1.5 font-semibold" title="collection.path this field points at (soft foreign key)">
                References
              </th>
              <th className="w-56 px-2 py-1.5 font-semibold" title="Comma-separated list of allowed values">
                Allowed values
              </th>
              <th className="px-2 py-1.5 font-semibold">Description</th>
              {coverage && (
                <th className="w-16 px-2 py-1.5 text-right font-semibold" title={`Share of the ${scanned} scanned documents (or parent items) carrying the field`}>
                  Seen
                </th>
              )}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {visible.map((f, i) => {
              const container = isContainer(f);
              const isCollapsed = collapsed.has(f.configPath);
              const isId = schema.idPaths?.includes(f.configPath) ?? false;
              const isCode = schema.protectedCodePaths?.includes(f.configPath) ?? false;
              const reference = schema.foreignKeys?.[f.configPath] ?? '';
              const seen = coverage?.[f.configPath];
              const name = f.key[f.key.length - 1] as string;
              return (
                <Fragment key={f.configPath}>
                  <tr className={`border-t border-zinc-900 ${container ? 'bg-zinc-900/40' : ''} hover:bg-zinc-900`}>
                    <td className="px-2 py-0.5 font-mono whitespace-nowrap" style={{ paddingLeft: 8 + (f.level - 1) * 20 }}>
                      {container ? (
                        <button
                          type="button"
                          aria-expanded={!isCollapsed}
                          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${f.configPath}`}
                          className="mr-1 w-3 text-zinc-500 hover:text-zinc-100"
                          onClick={() =>
                            setCollapsed((prev) => {
                              const next = new Set(prev);
                              if (next.has(f.configPath)) next.delete(f.configPath);
                              else next.add(f.configPath);
                              return next;
                            })
                          }
                        >
                          {isCollapsed ? '▸' : '▾'}
                        </button>
                      ) : (
                        <span className="mr-1 inline-block w-3" />
                      )}
                      <span className={container ? 'font-semibold text-sky-300' : 'text-zinc-100'} title={f.configPath}>
                        {name}
                        {f.def.type === 'array' && '[]'}
                      </span>
                      {container && <span className="ml-2 font-sans text-[11px] text-zinc-500">level {f.level + 1}</span>}
                    </td>
                    <td className="px-1 py-0.5">
                      <select
                        aria-label={`Type of ${f.configPath}`}
                        className={`${cellInput} font-mono`}
                        value={f.def.type ?? ''}
                        onChange={(e) => patch(f.key, { type: e.target.value })}
                      >
                        <option value="">—</option>
                        {[...new Set([...FIELD_TYPES, ...(f.def.type ? [f.def.type] : [])])].map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-0.5 whitespace-nowrap">
                      {!container && (
                        <>
                          <RoleToggle label="ID" on={isId} tone="amber" title="Identifier: renumbered when pasting with ID remapping" onClick={() => toggleList('idPaths', f.configPath)} />
                          <RoleToggle label="Code" on={isCode} tone="indigo" title="Domain code: shared reference value, never remapped" onClick={() => toggleList('protectedCodePaths', f.configPath)} />
                        </>
                      )}
                      {f.def.type === 'array' && childMap(f.def) && (
                        <select
                          aria-label={`Badge field of ${f.configPath}`}
                          title="Field shown as the [badge] for items of this array"
                          className="rounded border border-indigo-800 bg-indigo-950 px-1 font-mono text-[11px] text-indigo-200"
                          value={f.def.displayBadgeField ?? ''}
                          onChange={(e) => patch(f.key, { displayBadgeField: e.target.value })}
                        >
                          <option value="">badge: auto</option>
                          {Object.keys(childMap(f.def) ?? {}).map((k) => (
                            <option key={k} value={k}>
                              badge: {k}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-1 py-0.5">
                      {!container && (
                        <>
                          <input
                            key={`ref:${reference}`}
                            aria-label={`Reference of ${f.configPath}`}
                            className={`${cellInput} font-mono ${reference ? 'text-sky-300' : ''}`}
                            placeholder="—"
                            list="schema-reference-targets"
                            defaultValue={reference}
                            spellCheck={false}
                            onBlur={(e) => e.target.value.trim() !== reference && setReference(f.configPath, e.target.value)}
                          />
                        </>
                      )}
                    </td>
                    <td className="px-1 py-0.5">
                      {!container && (
                        <input
                          key={`enum:${(f.def.enum ?? []).join(',')}`}
                          aria-label={`Allowed values of ${f.configPath}`}
                          className={`${cellInput} font-mono`}
                          placeholder="any"
                          defaultValue={(f.def.enum ?? []).join(', ')}
                          spellCheck={false}
                          onBlur={(e) => {
                            const values = e.target.value.split(',').map((v) => v.trim()).filter(Boolean);
                            if (values.join(',') !== (f.def.enum ?? []).join(',')) patch(f.key, { enum: values });
                          }}
                        />
                      )}
                    </td>
                    <td className="px-1 py-0.5">
                      <input
                        key={`desc:${f.def.description ?? ''}`}
                        aria-label={`Description of ${f.configPath}`}
                        className={cellInput}
                        placeholder="—"
                        defaultValue={f.def.description ?? ''}
                        onBlur={(e) => e.target.value.trim() !== (f.def.description ?? '') && patch(f.key, { description: e.target.value.trim() })}
                      />
                    </td>
                    {coverage && (
                      <td className={`px-2 py-0.5 text-right font-mono text-xs ${seen === undefined ? 'text-zinc-600' : seen >= 0.999 ? 'text-emerald-400' : 'text-amber-300'}`}>
                        {seen === undefined ? 'never' : `${Math.round(seen * 100)}%`}
                      </td>
                    )}
                    <td className="px-1 py-0.5 text-right">
                      <button
                        type="button"
                        aria-label={`Remove ${f.configPath}`}
                        className="px-1 text-zinc-600 hover:text-red-400"
                        onClick={() => remove(f)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                  {closingAfter(i).map((c) => (
                    <AddFieldRow
                      key={`add:${c.configPath}`}
                      level={c.level + 1}
                      label={`field in ${c.configPath}${c.def.type === 'array' ? '[]' : ''}`}
                      onAdd={(n) => setFields(withField(fields, c.key, n, {}))}
                    />
                  ))}
                </Fragment>
              );
            })}
            <AddFieldRow level={1} label={`field on ${collection}`} onAdd={(n) => setFields(withField(fields, [], n, {}))} />
          </tbody>
        </table>
        <datalist id="schema-reference-targets">
          {referenceTargets.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        {flat.length === 0 && (
          <p className="p-4 text-sm text-zinc-500">
            Nothing documented yet. {canScan ? 'Use “Scan data” to read the fields from real documents, or add them by hand.' : 'Add fields by hand, or connect to a database to scan them.'}
          </p>
        )}
      </div>
    </div>
  );
}

const EMPTY_SCHEMA: CollectionSchema = {};

function AddFieldRow({ level, label, onAdd }: { level: number; label: string; onAdd: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <tr className="border-t border-zinc-900">
      <td colSpan={8} className="py-0.5" style={{ paddingLeft: 8 + (level - 1) * 20 + 16 }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (!n) return;
            onAdd(n);
            setName('');
          }}
        >
          <input
            className={`${cellInput} w-64 font-mono text-zinc-400`}
            placeholder={`+ ${label}`}
            aria-label={`Add ${label}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
          />
        </form>
      </td>
    </tr>
  );
}

function RoleToggle({ label, on, tone, title, onClick }: { label: string; on: boolean; tone: 'amber' | 'indigo'; title: string; onClick: () => void }) {
  const active = tone === 'amber' ? 'border-amber-600 bg-amber-950 text-amber-300' : 'border-indigo-700 bg-indigo-950 text-indigo-200';
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={`mr-1 rounded border px-1 text-[11px] ${on ? active : 'border-zinc-800 text-zinc-600 hover:text-zinc-300'}`}
    >
      {label}
    </button>
  );
}
