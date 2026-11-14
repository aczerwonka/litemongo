import { useEffect, useId, useMemo, useState } from 'react';
import { useCollectionNames, useKnownFields } from '../hooks/useCollectionInfo';
import type { ConnectionProfile } from '../store/useConnectionStore';
import type { QueryTab } from '../store/useTabStore';
import { useUiStore, type LinkDraft } from '../store/useUiStore';
import { useBlueprints, useSchemas, useWorkspaceStore } from '../store/useWorkspaceStore';
import type { CollectionSchema, RelationLevel } from '../types';
import { Button, ErrorBox, Field, inputClass, Modal, toast } from './ui';

/**
 * Relation Builder: link collections to the one being queried, right in the
 * workspace. A link reads "parent.field = child.field" (e.g. policies._id =
 * claims.policyId); the result is fetched with one batched $in query per link.
 *
 * Links live on the tab, so they can be tried out freely; "Save" stores the set
 * as a named Relation Blueprint in litemongo.config.json.
 */

const MAX_DEPTH = 3;
const MAX_LINKS = 8;

const mongoPath = (path: string) => path.replace(/\[\]/g, '');

/** Depth of every collection in the link tree (root = 1). */
function depths(root: string, levels: RelationLevel[]): Map<string, number> {
  const map = new Map<string, number>([[root, 1]]);
  let previous = root;
  for (const lvl of levels) {
    map.set(lvl.collection, (map.get(lvl.parentCollection ?? previous) ?? 1) + 1);
    previous = lvl.collection;
  }
  return map;
}

/** Remove a link and everything hanging below it. */
function withoutLevel(levels: RelationLevel[], index: number): RelationLevel[] {
  const removed = new Set<string>([(levels[index] as RelationLevel).collection]);
  return levels.filter((lvl, i) => {
    if (i === index) return false;
    if (lvl.parentCollection && removed.has(lvl.parentCollection)) {
      removed.add(lvl.collection);
      return false;
    }
    return true;
  });
}

interface Suggestion {
  parentCollection: string;
  localField: string;
  collection: string;
  foreignField: string;
}

/** Links implied by the schema's documented foreign keys, in both directions. */
function suggestionsFor(root: string, levels: RelationLevel[], schemas: Record<string, CollectionSchema>): Suggestion[] {
  const tree = depths(root, levels);
  const out: Suggestion[] = [];
  for (const [owner, schema] of Object.entries(schemas)) {
    for (const [fkPath, ref] of Object.entries(schema.foreignKeys ?? {})) {
      const dot = ref.indexOf('.');
      if (dot < 0) continue;
      const target = ref.slice(0, dot);
      const targetPath = mongoPath(ref.slice(dot + 1));
      const local = mongoPath(fkPath);
      // target in the tree -> offer the documents pointing at it (policies -> claims).
      if ((tree.get(target) ?? MAX_DEPTH) < MAX_DEPTH && !tree.has(owner)) {
        out.push({ parentCollection: target, localField: targetPath, collection: owner, foreignField: local });
      }
      // owner in the tree -> offer the document it points at (claims -> policies).
      if ((tree.get(owner) ?? MAX_DEPTH) < MAX_DEPTH && !tree.has(target)) {
        out.push({ parentCollection: owner, localField: local, collection: target, foreignField: targetPath });
      }
    }
  }
  return out;
}

function guessForeignField(
  parent: string,
  localField: string,
  child: string,
  schemas: Record<string, CollectionSchema>,
  childFields: string[],
): string {
  for (const [path, ref] of Object.entries(schemas[child]?.foreignKeys ?? {})) {
    if (mongoPath(ref) === `${parent}.${localField}`) return mongoPath(path);
  }
  for (const [path, ref] of Object.entries(schemas[parent]?.foreignKeys ?? {})) {
    if (mongoPath(path) === localField && ref.startsWith(`${child}.`)) return mongoPath(ref.slice(child.length + 1));
  }
  if (localField !== '_id' && childFields.includes(localField)) return localField;
  if (localField === '_id') {
    const singular = parent.replace(/ies$/, 'y').replace(/s$/, '');
    const candidate = childFields.find((f) => f.toLowerCase() === `${singular}id`.toLowerCase().replace(/_/g, ''));
    if (candidate) return candidate;
    return '';
  }
  return '_id';
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'relation';
}

export function RelationBar({
  tab,
  profile,
  db,
  onChange,
}: {
  tab: QueryTab;
  profile: ConnectionProfile | undefined;
  db: string | null;
  /** New link set for the tab (and the saved blueprint it now corresponds to, if any). */
  onChange: (levels: RelationLevel[], blueprintId: string | null) => void;
}) {
  const root = tab.collection as string;
  const levels = tab.levels;
  const draft = useUiStore((s) => s.linkDraft);
  const openLink = useUiStore((s) => s.openLink);
  const closeLink = useUiStore((s) => s.closeLink);
  const schemas = useSchemas();
  const blueprints = useBlueprints();
  const saveBlueprint = useWorkspaceStore((s) => s.saveBlueprint);
  const removeBlueprint = useWorkspaceStore((s) => s.removeBlueprint);
  const saved = useMemo(() => blueprints.filter((b) => b.rootCollection === root), [blueprints, root]);
  const current = saved.find((b) => b.id === tab.blueprintId);
  const dirty = !!current && JSON.stringify(current.levels) !== JSON.stringify(levels);
  const tree = depths(root, levels);
  const suggestions = useMemo(() => suggestionsFor(root, levels, schemas), [root, levels, schemas]);

  const addLevel = (s: Suggestion, editIndex?: number) => {
    const level: RelationLevel = {
      level: (tree.get(s.parentCollection) ?? 1) + 1,
      collection: s.collection,
      parentCollection: s.parentCollection,
      localField: s.localField,
      foreignField: s.foreignField,
    };
    onChange(editIndex === undefined ? [...levels, level] : levels.map((l, i) => (i === editIndex ? level : l)), tab.blueprintId);
  };

  const save = () => {
    if (current) {
      saveBlueprint({ ...current, levels });
      toast(`Saved "${current.name ?? current.id}"`);
      return;
    }
    const name = window.prompt('Name for this set of relations', `${root} → ${levels.map((l) => l.collection).join(', ')}`);
    if (!name) return;
    let id = slug(name);
    while (blueprints.some((b) => b.id === id)) id += '-2';
    saveBlueprint({ id, name, rootCollection: root, levels });
    onChange(levels, id);
    toast(`Saved "${name}" to the workspace config`);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm" aria-label="Relations">
      <span className="text-zinc-500" title="Collections linked to the queried one. Each link costs one batched $in query.">
        ⛓ Links
      </span>
      {levels.length === 0 && <span className="text-zinc-600">none</span>}
      {levels.map((lvl, i) => {
        const parent = lvl.parentCollection ?? (i === 0 ? root : (levels[i - 1] as RelationLevel).collection);
        return (
          <span
            key={`${lvl.collection}:${i}`}
            className="inline-flex items-center overflow-hidden rounded border border-emerald-800 bg-emerald-950 font-mono text-xs text-emerald-200"
          >
            <button
              type="button"
              title={`Level ${tree.get(lvl.collection) ?? '?'} — click to edit`}
              className="px-1.5 py-0.5 hover:bg-emerald-900"
              onClick={() => openLink({ ...lvl, parentCollection: parent, editIndex: i })}
            >
              {(tree.get(lvl.collection) ?? 2) > 2 && <span className="text-emerald-500">↳ </span>}
              {parent}.{lvl.localField} <span className="text-emerald-500">=</span> {lvl.collection}.{lvl.foreignField}
            </button>
            <button
              type="button"
              aria-label={`Remove link to ${lvl.collection}`}
              className="border-l border-emerald-800 px-1 py-0.5 hover:bg-emerald-900"
              onClick={() => onChange(withoutLevel(levels, i), tab.blueprintId)}
            >
              ✕
            </button>
          </span>
        );
      })}
      {suggestions.slice(0, 3).map((s) => (
        <button
          key={`${s.parentCollection}.${s.localField}:${s.collection}.${s.foreignField}`}
          type="button"
          title={`Suggested by the schema: ${s.parentCollection}.${s.localField} = ${s.collection}.${s.foreignField}`}
          className="rounded border border-dashed border-zinc-700 px-1.5 py-0.5 font-mono text-xs text-zinc-400 hover:border-emerald-600 hover:text-emerald-300"
          onClick={() => addLevel(s)}
        >
          + {s.collection}
          <span className="text-zinc-600"> on {s.foreignField}</span>
        </button>
      ))}
      <Button className="px-1.5 py-0.5 text-xs" onClick={() => openLink({})} disabled={levels.length >= MAX_LINKS} title="Link a collection (Alt+L)">
        + Link…
      </Button>
      {levels.length > 0 && (
        <Button variant="ghost" className="px-1.5 py-0.5 text-xs" onClick={() => onChange([], null)} title="Remove every link (plain query)">
          ✕ Clear links
        </Button>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {saved.length > 0 && (
          <select
            aria-label="Saved relations"
            className={`${inputClass} py-0.5 text-xs`}
            value={tab.blueprintId ?? ''}
            onChange={(e) => {
              const bp = saved.find((b) => b.id === e.target.value);
              // "No saved relations" drops the links too; use ✕ Clear links / edit chips for finer control.
              onChange(bp ? bp.levels : [], bp ? bp.id : null);
            }}
          >
            <option value="">{tab.blueprintId ? '— No relations (unload) —' : 'Saved relations…'}</option>
            {saved.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name ?? b.id}
              </option>
            ))}
          </select>
        )}
        {levels.length > 0 && (!current || dirty) && (
          <Button className="px-1.5 py-0.5 text-xs" onClick={save} title="Save these links to the workspace config">
            {current ? 'Save changes' : 'Save…'}
          </Button>
        )}
        {current && (
          <Button
            variant="ghost"
            className="px-1.5 py-0.5 text-xs"
            title={`Delete saved relations "${current.name ?? current.id}"`}
            onClick={() => {
              if (!window.confirm(`Delete saved relations "${current.name ?? current.id}" from the workspace config?`)) return;
              removeBlueprint(current.id);
              onChange(levels, null);
            }}
          >
            🗑
          </Button>
        )}
      </span>
      {draft && (
        <LinkEditor
          draft={draft}
          root={root}
          levels={levels}
          profile={profile}
          db={db}
          schemas={schemas}
          suggestions={suggestions}
          onClose={closeLink}
          onSubmit={(s, editIndex) => {
            addLevel(s, editIndex);
            closeLink();
          }}
        />
      )}
    </div>
  );
}

function LinkEditor({
  draft,
  root,
  levels,
  profile,
  db,
  schemas,
  suggestions,
  onClose,
  onSubmit,
}: {
  draft: LinkDraft;
  root: string;
  levels: RelationLevel[];
  profile: ConnectionProfile | undefined;
  db: string | null;
  schemas: Record<string, CollectionSchema>;
  suggestions: Suggestion[];
  onClose: () => void;
  onSubmit: (link: Suggestion, editIndex?: number) => void;
}) {
  const editing = draft.editIndex !== undefined;
  const tree = depths(root, levels);
  const parents = [...tree.entries()]
    .filter(([name, depth]) => depth < MAX_DEPTH && !(editing && name === draft.collection))
    .map(([name]) => name);
  const draftParent = draft.parentCollection && parents.includes(draft.parentCollection) ? draft.parentCollection : root;
  const [parent, setParent] = useState(draftParent);
  const [localField, setLocalField] = useState(draft.localField ?? '_id');
  const [collection, setCollection] = useState(draft.collection ?? '');
  const [foreignField, setForeignField] = useState(draft.foreignField ?? '');
  const [touchedForeign, setTouchedForeign] = useState(!!draft.foreignField);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  const collections = useCollectionNames(profile, db);
  const candidates = [...new Set([...collections, ...Object.keys(schemas)])]
    .filter((c) => !tree.has(c) || (editing && c === draft.collection))
    .sort();
  const parentFields = useKnownFields(profile, db, parent);
  const childFields = useKnownFields(profile, db, collection || null);

  // Propose the matching field on the other side until the user types their own.
  useEffect(() => {
    if (touchedForeign || !collection) return;
    setForeignField(guessForeignField(parent, localField, collection, schemas, childFields));
  }, [touchedForeign, parent, localField, collection, schemas, childFields]);

  const submit = () => {
    if (!parent || !localField.trim() || !collection || !foreignField.trim()) {
      setError('Pick both collections and the two fields that must match.');
      return;
    }
    onSubmit(
      { parentCollection: parent, localField: mongoPath(localField.trim()), collection, foreignField: mongoPath(foreignField.trim()) },
      draft.editIndex,
    );
  };

  return (
    <Modal
      title={editing ? 'Edit link' : 'Link a collection'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            {editing ? 'Update link' : 'Add link'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {!editing && suggestions.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-zinc-400">From the schema's documented references</span>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={`${s.parentCollection}.${s.localField}:${s.collection}.${s.foreignField}`}
                  type="button"
                  className="rounded border border-zinc-700 px-2 py-1 font-mono text-xs text-zinc-300 hover:border-emerald-600 hover:text-emerald-300"
                  onClick={() => onSubmit(s)}
                >
                  {s.parentCollection}.{s.localField} = {s.collection}.{s.foreignField}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="From collection">
            <select className={inputClass} value={parent} onChange={(e) => setParent(e.target.value)}>
              {parents.map((p) => (
                <option key={p} value={p}>
                  {p} (level {tree.get(p)})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Field" hint="Nested paths work: covers.coverId">
            <input
              className={`${inputClass} font-mono`}
              value={localField}
              list={`${ids}-parent`}
              onChange={(e) => setLocalField(e.target.value)}
              spellCheck={false}
            />
            <datalist id={`${ids}-parent`}>
              {parentFields.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
          <Field label="Linked collection">
            <select
              className={inputClass}
              value={collection}
              disabled={editing}
              autoFocus={!editing}
              onChange={(e) => setCollection(e.target.value)}
            >
              <option value="">Select…</option>
              {candidates.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Matching field">
            <input
              className={`${inputClass} font-mono`}
              value={foreignField}
              list={`${ids}-child`}
              onChange={(e) => {
                setTouchedForeign(true);
                setForeignField(e.target.value);
              }}
              spellCheck={false}
            />
            <datalist id={`${ids}-child`}>
              {childFields.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
        </div>
        <div className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm">
          <span className="text-zinc-300">
            {parent}.{localField || '?'}
          </span>
          <span className="text-emerald-400"> = </span>
          <span className="text-zinc-300">
            {collection || '?'}.{foreignField || '?'}
          </span>
          <div className="mt-1 font-sans text-xs text-zinc-500">
            For every {parent} document, shows the {collection || 'linked'} documents whose {foreignField || 'field'} equals its{' '}
            {localField || 'field'}.
          </div>
        </div>
        <ErrorBox error={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
