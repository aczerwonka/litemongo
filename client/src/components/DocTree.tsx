import { useState } from 'react';
import { classify } from '../lib/ejson';
import type { CollectionSchema, EjsonDoc, MasterDetailNode } from '../types';
import { CodeBadge, Compact, Scalar } from './values';

export function DocTree({
  doc,
  node,
  collection,
  schemas,
  defaultOpen,
  selected,
  onToggleSelect,
  depth = 0,
}: {
  doc: EjsonDoc;
  node?: MasterDetailNode | undefined;
  collection: string;
  schemas: Record<string, CollectionSchema>;
  defaultOpen: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const schema = schemas[collection];
  const badgeField = schema?.displayBadgeField;
  const children = node ? Object.entries(node.children) : [];
  return (
    <div style={{ marginLeft: depth ? 16 : 0 }}>
      <div className="flex items-center gap-1.5">
        {onToggleSelect && <input type="checkbox" aria-label="Select document" checked={!!selected} onChange={onToggleSelect} />}
        <button type="button" className="text-zinc-500 hover:text-zinc-200" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '▾' : '▸'}
        </button>
        {depth > 0 && <span className="text-xs text-zinc-500">{collection}</span>}
        <Scalar value={doc._id} />
        {badgeField && doc[badgeField] !== undefined && <CodeBadge value={doc[badgeField]} title={badgeField} />}
        {children.map(([c, list]) => (
          <span key={c} className="text-xs text-zinc-500">
            · {c} ({list.length})
          </span>
        ))}
      </div>
      {open && (
        <div className="ml-5 border-l border-zinc-800 pl-3">
          {Object.entries(doc).map(([k, v]) => (
            <JsonNode key={k} name={k} value={v} path={[k]} schema={schema} />
          ))}
          {children.map(([childCollection, list]) => (
            <div key={childCollection} className="mt-1">
              <div className="text-xs font-semibold text-emerald-400">
                ⛓ {childCollection} ({list.length})
              </div>
              {list.map((child, i) => (
                <DocTree
                  key={i}
                  doc={child.doc}
                  node={child}
                  collection={childCollection}
                  schemas={schemas}
                  defaultOpen={false}
                  depth={depth + 1}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JsonNode({
  name,
  value,
  path,
  schema,
}: {
  name: string;
  value: unknown;
  path: string[];
  schema: CollectionSchema | undefined;
}) {
  const c = classify(value);
  const [open, setOpen] = useState(false);
  if (c.kind !== 'object' && c.kind !== 'array') {
    return (
      <div className="whitespace-nowrap">
        <span className="text-zinc-300">{name}</span>
        <span className="text-zinc-600">: </span>
        <Scalar value={value} />
      </div>
    );
  }
  const entries: [string, unknown][] =
    c.kind === 'array' ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value as object);
  return (
    <div>
      <button type="button" className="flex items-center gap-1.5 whitespace-nowrap text-left" onClick={() => setOpen(!open)}>
        <span className="text-zinc-500">{open ? '▾' : '▸'}</span>
        <span className="text-zinc-300">{name}</span>
        <span className="text-zinc-600">{c.kind === 'array' ? `[${entries.length}]` : `{${entries.length}}`}</span>
        {!open && <Compact value={value} schema={schema} path={path} />}
      </button>
      {open && (
        <div className="ml-2 border-l border-zinc-800 pl-3">
          {entries.map(([k, v]) => (
            // Array elements share their parent's schema path (covers[] -> covers).
            <JsonNode key={k} name={k} value={v} path={c.kind === 'array' ? path : [...path, k]} schema={schema} />
          ))}
        </div>
      )}
    </div>
  );
}
