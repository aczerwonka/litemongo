import { useMemo, useState } from 'react';
import { classify, pretty } from '../lib/ejson';
import { collectPathValues } from '../lib/paths';
import type { CollectionSchema, EjsonDoc, Recipe, RecipeNode, RecipeRunResponse, RecipeStep } from '../types';
import { DocTree } from './DocTree';
import { CodeBadge, Compact } from './values';

/**
 * Presentations of a recipe run:
 *   - Dossier: one "file" per root document — header, key fields, and a section
 *     per child step (cards / compact table / chips), recursively.
 *   - Board:   root cards in columns grouped by a field (e.g. claim status).
 *   - Trace:   waterfall of every query the algorithm issued, with timings.
 *   - JSON:    the stitched hierarchy as Extended JSON.
 */

/** Per-step accent colours (literal classes so Tailwind keeps them). */
export const STEP_COLORS = [
  { dot: 'bg-emerald-500', border: 'border-emerald-700/70', text: 'text-emerald-300', bar: 'bg-emerald-600' },
  { dot: 'bg-sky-500', border: 'border-sky-700/70', text: 'text-sky-300', bar: 'bg-sky-600' },
  { dot: 'bg-amber-500', border: 'border-amber-700/70', text: 'text-amber-300', bar: 'bg-amber-600' },
  { dot: 'bg-violet-500', border: 'border-violet-700/70', text: 'text-violet-300', bar: 'bg-violet-600' },
  { dot: 'bg-pink-500', border: 'border-pink-700/70', text: 'text-pink-300', bar: 'bg-pink-600' },
  { dot: 'bg-teal-500', border: 'border-teal-700/70', text: 'text-teal-300', bar: 'bg-teal-600' },
  { dot: 'bg-orange-500', border: 'border-orange-700/70', text: 'text-orange-300', bar: 'bg-orange-600' },
  { dot: 'bg-lime-500', border: 'border-lime-700/70', text: 'text-lime-300', bar: 'bg-lime-600' },
] as const;

export function stepColor(recipe: Recipe, stepId: string) {
  const i = Math.max(0, recipe.steps.findIndex((s) => s.id === stepId));
  return STEP_COLORS[i % STEP_COLORS.length] as (typeof STEP_COLORS)[number];
}

export function strategyLabel(step: RecipeStep, isRoot: boolean): string {
  if (isRoot) return `◉ find ≤${step.limit ?? 50}`;
  switch (step.strategy ?? 'in') {
    case 'batched':
      return `▦ batched ×${step.batchSize ?? 100}${(step.concurrency ?? 1) > 1 ? ` ∥${step.concurrency}` : ''}`;
    case 'nested-loop':
      return `↻ per parent ≤${step.limit ?? 10}${(step.concurrency ?? 4) > 1 ? ` ∥${step.concurrency ?? 4}` : ''}`;
    default:
      return '⇉ $in';
  }
}

export const STRATEGY_HELP: Record<string, string> = {
  root: 'One find() on the root collection.',
  in: 'One query for all parents: { foreignField: { $in: [unique parent keys] } }, stitched in memory.',
  batched: 'Parent keys go out in packets of batchSize ($in per packet), concurrency packets at a time — gentler on a busy server than one huge $in.',
  'nested-loop': 'One query per parent document, each with its own sort and limit (e.g. the latest 3 claims of every policy).',
};

interface ViewProps {
  recipe: Recipe;
  result: RecipeRunResponse;
  schemas: Record<string, CollectionSchema>;
}

// --- value helpers -----------------------------------------------------------

function valueAt(doc: EjsonDoc, path: string): unknown {
  if (path in doc) return doc[path];
  const values = collectPathValues(doc, path);
  return values.length === 0 ? undefined : values.length === 1 ? values[0] : values;
}

function text(value: unknown): string {
  if (value === undefined) return '';
  return classify(value).text;
}

function titleOf(step: RecipeStep, node: RecipeNode, schemas: Record<string, CollectionSchema>): string {
  const field = step.display?.title ?? schemas[step.collection]?.displayBadgeField;
  const v = field ? valueAt(node.doc, field) : undefined;
  return v !== undefined ? text(v) : text(node.doc._id);
}

/** Fields listed on a card: configured, else the first few top-level fields. */
function fieldsOf(step: RecipeStep, sample: EjsonDoc | undefined): string[] {
  if (step.display?.fields && step.display.fields.length > 0) return step.display.fields;
  if (!sample) return [];
  const skip = new Set(['_id', step.display?.title, step.display?.subtitle, step.display?.badge, step.foreignField]);
  return Object.keys(sample)
    .filter((k) => !skip.has(k))
    .slice(0, 6);
}

const lastSegment = (path: string) => path.split('.').pop() ?? path;

function FieldValue({ doc, path, collection, schemas }: { doc: EjsonDoc; path: string; collection: string; schemas: Record<string, CollectionSchema> }) {
  const v = valueAt(doc, path);
  if (v === undefined) return <span className="text-zinc-600">—</span>;
  return <Compact value={v} schema={schemas[collection]} path={path.split('.')} />;
}

function childSteps(recipe: Recipe, stepId: string): RecipeStep[] {
  return recipe.steps.filter((s) => s.parent === stepId);
}

// --- Dossier -----------------------------------------------------------------

export function DossierView({ recipe, result, schemas }: ViewProps) {
  const root = recipe.steps[0] as RecipeStep;
  if (result.roots.length === 0) return <div className="p-4 text-sm text-zinc-500">No root documents matched.</div>;
  return (
    <div className="h-full overflow-auto p-3">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        {result.roots.map((node, i) => (
          <DossierCard key={i} recipe={recipe} step={root} node={node} schemas={schemas} index={i + 1} />
        ))}
      </div>
    </div>
  );
}

function DossierCard({ recipe, step, node, schemas, index }: { recipe: Recipe; step: RecipeStep; node: RecipeNode; schemas: Record<string, CollectionSchema>; index: number }) {
  const [raw, setRaw] = useState(false);
  const color = stepColor(recipe, step.id);
  const fields = fieldsOf(step, node.doc);
  const badge = step.display?.badge;
  const subtitle = step.display?.subtitle;
  return (
    <article className={`rounded-lg border-l-4 border border-zinc-800 bg-zinc-900/60 ${color.border}`}>
      <header className="flex flex-wrap items-baseline gap-2 border-b border-zinc-800 px-4 py-2.5">
        <span className="text-xs text-zinc-500 tabular-nums">#{index}</span>
        <h3 className="text-base font-semibold text-zinc-50">{titleOf(step, node, schemas)}</h3>
        {subtitle && <span className="text-sm text-zinc-400">{text(valueAt(node.doc, subtitle))}</span>}
        {badge && valueAt(node.doc, badge) !== undefined && <CodeBadge value={valueAt(node.doc, badge)} title={badge} />}
        <span className="ml-auto font-mono text-[11px] text-zinc-500">
          {step.collection} · {text(node.doc._id)}
        </span>
        <button type="button" className="text-xs text-zinc-500 hover:text-zinc-200" onClick={() => setRaw(!raw)} aria-expanded={raw}>
          {raw ? '▾ document' : '▸ document'}
        </button>
      </header>
      {fields.length > 0 && (
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-x-4 gap-y-2 px-4 py-3 text-sm">
          {fields.map((f) => (
            <div key={f} className="min-w-0">
              <dt className="truncate text-[11px] tracking-wide text-zinc-500 uppercase" title={f}>
                {lastSegment(f)}
              </dt>
              <dd className="truncate">
                <FieldValue doc={node.doc} path={f} collection={step.collection} schemas={schemas} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {raw && (
        <div className="border-t border-zinc-800 px-4 py-2 font-mono text-xs">
          <DocTree doc={node.doc} collection={step.collection} schemas={schemas} defaultOpen />
        </div>
      )}
      <ChildSections recipe={recipe} stepId={step.id} node={node} schemas={schemas} />
    </article>
  );
}

function ChildSections({ recipe, stepId, node, schemas }: { recipe: Recipe; stepId: string; node: RecipeNode; schemas: Record<string, CollectionSchema> }) {
  const steps = childSteps(recipe, stepId);
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-col gap-3 border-t border-zinc-800 px-4 py-3">
      {steps.map((s) => (
        <StepSection key={s.id} recipe={recipe} step={s} nodes={node.children[s.id] ?? []} schemas={schemas} />
      ))}
    </div>
  );
}

function StepSection({ recipe, step, nodes, schemas }: { recipe: Recipe; step: RecipeStep; nodes: RecipeNode[]; schemas: Record<string, CollectionSchema> }) {
  const color = stepColor(recipe, step.id);
  const layout = step.display?.layout ?? 'cards';
  return (
    <section>
      <h4 className="mb-1.5 flex items-center gap-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">
        <span className={`h-2 w-2 rounded-full ${color.dot}`} />
        {step.label ?? step.id}
        <span className="font-normal text-zinc-500 normal-case">
          {nodes.length} · {step.collection} · <span title={STRATEGY_HELP[step.strategy ?? 'in']}>{strategyLabel(step, false)}</span>
        </span>
      </h4>
      {nodes.length === 0 ? (
        <p className="text-xs text-zinc-600">none</p>
      ) : layout === 'table' ? (
        <StepTable recipe={recipe} step={step} nodes={nodes} schemas={schemas} />
      ) : layout === 'chips' ? (
        <div className="flex flex-wrap gap-1.5">
          {nodes.map((n, i) => (
            <Chip key={i} recipe={recipe} step={step} node={n} schemas={schemas} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
          {nodes.map((n, i) => (
            <MiniCard key={i} recipe={recipe} step={step} node={n} schemas={schemas} />
          ))}
        </div>
      )}
    </section>
  );
}

function Chip({ recipe, step, node, schemas }: { recipe: Recipe; step: RecipeStep; node: RecipeNode; schemas: Record<string, CollectionSchema> }) {
  const color = stepColor(recipe, step.id);
  const badge = step.display?.badge;
  const subtitle = step.display?.subtitle;
  const tip = fieldsOf(step, node.doc)
    .map((f) => `${f}: ${text(valueAt(node.doc, f))}`)
    .join('\n');
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border bg-zinc-950 px-2 py-0.5 text-xs ${color.border}`} title={tip}>
      {badge && valueAt(node.doc, badge) !== undefined && <CodeBadge value={valueAt(node.doc, badge)} title={badge} />}
      <span className="text-zinc-100">{titleOf(step, node, schemas)}</span>
      {subtitle && <span className="text-zinc-500">{text(valueAt(node.doc, subtitle))}</span>}
    </span>
  );
}

function MiniCard({ recipe, step, node, schemas }: { recipe: Recipe; step: RecipeStep; node: RecipeNode; schemas: Record<string, CollectionSchema> }) {
  const color = stepColor(recipe, step.id);
  const badge = step.display?.badge;
  const subtitle = step.display?.subtitle;
  return (
    <div className={`rounded border border-l-2 border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5 text-xs ${color.border}`}>
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className="font-semibold text-zinc-100">{titleOf(step, node, schemas)}</span>
        {subtitle && <span className="text-zinc-500">{text(valueAt(node.doc, subtitle))}</span>}
        {badge && valueAt(node.doc, badge) !== undefined && <CodeBadge value={valueAt(node.doc, badge)} title={badge} />}
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        {fieldsOf(step, node.doc).map((f) => (
          <FieldRow key={f} doc={node.doc} path={f} collection={step.collection} schemas={schemas} />
        ))}
      </dl>
      {childSteps(recipe, step.id).map((s) => (
        <div key={s.id} className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className={`text-[10px] uppercase ${stepColor(recipe, s.id).text}`}>{s.label ?? s.id}</span>
          {(node.children[s.id] ?? []).map((c, i) => (
            <Chip key={i} recipe={recipe} step={s} node={c} schemas={schemas} />
          ))}
          {(node.children[s.id] ?? []).length === 0 && <span className="text-zinc-600">none</span>}
        </div>
      ))}
    </div>
  );
}

function FieldRow({ doc, path, collection, schemas }: { doc: EjsonDoc; path: string; collection: string; schemas: Record<string, CollectionSchema> }) {
  return (
    <>
      <dt className="text-zinc-500" title={path}>
        {lastSegment(path)}
      </dt>
      <dd className="min-w-0 truncate">
        <FieldValue doc={doc} path={path} collection={collection} schemas={schemas} />
      </dd>
    </>
  );
}

function StepTable({ recipe, step, nodes, schemas }: { recipe: Recipe; step: RecipeStep; nodes: RecipeNode[]; schemas: Record<string, CollectionSchema> }) {
  const fields = fieldsOf(step, nodes[0]?.doc);
  const kids = childSteps(recipe, step.id);
  const badge = step.display?.badge;
  return (
    <div className="overflow-x-auto rounded border border-zinc-800">
      <table className="w-full text-xs">
        <thead className="bg-zinc-900 text-left text-zinc-500">
          <tr>
            <th className="px-2 py-1 font-medium">{step.display?.title ?? '_id'}</th>
            {badge && <th className="px-2 py-1 font-medium">{lastSegment(badge)}</th>}
            {fields.map((f) => (
              <th key={f} className="px-2 py-1 font-medium" title={f}>
                {lastSegment(f)}
              </th>
            ))}
            {kids.map((k) => (
              <th key={k.id} className={`px-2 py-1 font-medium ${stepColor(recipe, k.id).text}`}>
                {k.label ?? k.id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes.map((n, i) => (
            <tr key={i} className="border-t border-zinc-800 align-top hover:bg-zinc-900/60">
              <td className="px-2 py-1 font-medium whitespace-nowrap text-zinc-100">{titleOf(step, n, schemas)}</td>
              {badge && <td className="px-2 py-1">{valueAt(n.doc, badge) !== undefined && <CodeBadge value={valueAt(n.doc, badge)} title={badge} />}</td>}
              {fields.map((f) => (
                <td key={f} className="max-w-64 truncate px-2 py-1">
                  <FieldValue doc={n.doc} path={f} collection={step.collection} schemas={schemas} />
                </td>
              ))}
              {kids.map((k) => (
                <td key={k.id} className="px-2 py-1">
                  <div className="flex flex-wrap gap-1">
                    {(n.children[k.id] ?? []).map((c, j) => (
                      <Chip key={j} recipe={recipe} step={k} node={c} schemas={schemas} />
                    ))}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Board -------------------------------------------------------------------

export function BoardView({ recipe, result, schemas, groupBy }: ViewProps & { groupBy: string }) {
  const root = recipe.steps[0] as RecipeStep;
  const columns = useMemo(() => {
    const map = new Map<string, RecipeNode[]>();
    for (const node of result.roots) {
      const key = text(valueAt(node.doc, groupBy)) || '∅';
      const list = map.get(key);
      if (list) list.push(node);
      else map.set(key, [node]);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [result.roots, groupBy]);
  if (result.roots.length === 0) return <div className="p-4 text-sm text-zinc-500">No root documents matched.</div>;
  return (
    <div className="flex h-full gap-3 overflow-x-auto p-3">
      {columns.map(([key, nodes]) => (
        <section key={key} className="flex w-72 shrink-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900/40">
          <h3 className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-sm font-semibold text-zinc-200">
            <CodeBadge value={key} title={groupBy} />
            <span className="ml-auto text-xs font-normal text-zinc-500 tabular-nums">{nodes.length}</span>
          </h3>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
            {nodes.map((n, i) => (
              <MiniCard key={i} recipe={recipe} step={root} node={n} schemas={schemas} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// --- Trace -------------------------------------------------------------------

export function TraceView({ recipe, result }: Omit<ViewProps, 'schemas'>) {
  const span = Math.max(1, ...result.trace.map((t) => t.start + Math.max(t.ms, 1)));
  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3 text-xs">
      <table className="w-full max-w-4xl">
        <thead className="text-left text-zinc-500">
          <tr>
            <th className="py-1 pr-3 font-medium">Step</th>
            <th className="py-1 pr-3 font-medium">Algorithm</th>
            <th className="py-1 pr-3 text-right font-medium">Queries</th>
            <th className="py-1 pr-3 text-right font-medium" title="Unique parent keys ($in / batched) or parents queried (nested loop)">
              Keys
            </th>
            <th className="py-1 pr-3 text-right font-medium">Docs</th>
            <th className="py-1 pr-3 text-right font-medium">ms</th>
            <th className="py-1 font-medium" />
          </tr>
        </thead>
        <tbody>
          {result.steps.map((s) => {
            const step = recipe.steps.find((x) => x.id === s.step);
            return (
              <tr key={s.step} className="border-t border-zinc-800">
                <td className="py-1 pr-3">
                  <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${stepColor(recipe, s.step).dot}`} />
                  <span className="text-zinc-100">{step?.label ?? s.step}</span>
                  <span className="ml-1.5 font-mono text-zinc-500">{s.collection}</span>
                </td>
                <td className="py-1 pr-3 font-mono text-zinc-300" title={STRATEGY_HELP[s.strategy]}>
                  {step ? strategyLabel(step, s.strategy === 'root') : s.strategy}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">{s.queries}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{s.strategy === 'root' ? '' : s.keys}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{s.docs}</td>
                <td className="py-1 pr-3 text-right tabular-nums">{s.ms}</td>
                <td className="py-1 text-amber-400">
                  {s.truncated && 'limit reached '}
                  {s.skippedParents > 0 && `${s.skippedParents} parents skipped`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div>
        <div className="mb-1 flex items-center justify-between text-zinc-500">
          <span>Query waterfall ({result.trace.length} queries{result.traceTruncated ? ', first 1000 shown' : ''})</span>
          <span className="tabular-nums">{span} ms</span>
        </div>
        <div className="flex flex-col gap-px">
          {result.trace.map((t, i) => {
            const color = stepColor(recipe, t.step);
            return (
              <div key={i} className="grid grid-cols-[minmax(0,14rem)_1fr_5rem] items-center gap-2" title={`${t.step} · ${t.label} · ${t.docs} docs${t.keys !== undefined ? ` · ${t.keys} keys` : ''} · ${t.ms} ms`}>
                <span className="truncate font-mono text-zinc-400">
                  <span className={color.text}>{t.step}</span> {t.label}
                </span>
                <div className="relative h-3 rounded-sm bg-zinc-900">
                  <div
                    className={`absolute top-0 h-3 rounded-sm ${color.bar}`}
                    style={{ left: `${(t.start / span) * 100}%`, width: `max(2px, ${(Math.max(t.ms, 0.5) / span) * 100}%)` }}
                  />
                </div>
                <span className="text-right text-zinc-500 tabular-nums">
                  {t.docs} · {t.ms}ms
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// --- JSON --------------------------------------------------------------------

function plain(node: RecipeNode): unknown {
  const kids = Object.entries(node.children);
  return kids.length === 0 ? node.doc : { ...node.doc, $children: Object.fromEntries(kids.map(([k, v]) => [k, v.map(plain)])) };
}

export function JsonView({ result }: { result: RecipeRunResponse }) {
  const textValue = useMemo(() => pretty(result.roots.map(plain)), [result.roots]);
  return <pre className="h-full overflow-auto p-3 font-mono text-xs text-zinc-300">{textValue}</pre>;
}
