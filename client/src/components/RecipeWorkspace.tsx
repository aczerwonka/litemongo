import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { parseRecipe } from '../../../server/src/lib/recipe';
import { useHotkeys } from '../hooks/useHotkeys';
import { api, defaultDbFromUri } from '../lib/api';
import { BUILTIN_RECIPES, blankRecipe, isBuiltin } from '../lib/recipeTemplates';
import { contextFor, useConnectionStore, useProfile } from '../store/useConnectionStore';
import { usePaneSize } from '../store/useLayoutStore';
import { useTabStore, type QueryTab, type RecipeViewMode } from '../store/useTabStore';
import { useRecipes, useSchemas, useWorkspaceStore } from '../store/useWorkspaceStore';
import type { Recipe, RecipeRunResponse, RecipeStep, RecipeStrategy } from '../types';
import { JsonEditor } from './JsonEditor';
import { BoardView, DossierView, JsonView, STRATEGY_HELP, TraceView, stepColor, strategyLabel } from './RecipeViews';
import { ModeSwitch } from './ScriptWorkspace';
import { Splitter } from './Splitter';
import { Button, Dropdown, ErrorBox, inputClass, toast, useServerInfo } from './ui';

/**
 * Recipe mode: pick a ready-made template (or a saved recipe), fill its
 * parameters and run a multi-step fetch — root find, then each child step with
 * its own algorithm ($in, batched $in packets, per-parent nested loop). The
 * result is shown as a dossier, a board, or the query waterfall.
 */

interface RunSpec {
  connectionId: string;
  db: string;
  recipe: Recipe;
  params: Record<string, string>;
  at: number;
}

const VIEWS: { mode: RecipeViewMode; label: string; title: string }[] = [
  { mode: 'dossier', label: 'Dossier', title: 'One file per root document with its details as sections' },
  { mode: 'board', label: 'Board', title: 'Root documents as cards in columns grouped by a field' },
  { mode: 'trace', label: 'Trace', title: 'Every query the algorithm issued: waterfall with timings' },
  { mode: 'json', label: 'JSON', title: 'The stitched hierarchy as Extended JSON' },
];

export function recipeText(recipe: Recipe): string {
  return JSON.stringify(recipe, null, 2);
}

/** Tab patch that loads a recipe into the editor. */
export function loadRecipePatch(recipe: Recipe): Partial<QueryTab> {
  return {
    mode: 'recipe',
    recipeId: recipe.id,
    recipeName: recipe.name ?? recipe.id,
    recipeText: recipeText(recipe),
    recipeParams: Object.fromEntries((recipe.params ?? []).map((p) => [p.name, p.default ?? ''])),
    recipeView: null,
  };
}

function parseDraft(textValue: string): { recipe: Recipe | null; error: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(textValue);
  } catch (err) {
    return { recipe: null, error: `Invalid JSON: ${(err as Error).message}` };
  }
  try {
    return { recipe: parseRecipe(raw), error: null };
  } catch (err) {
    return { recipe: null, error: (err as Error).message };
  }
}

export function RecipeWorkspace({ tab, active }: { tab: QueryTab; active: boolean }) {
  const updateTab = useTabStore((s) => s.updateTab);
  const profile = useProfile(tab.connectionId);
  const forceReadOnly = useServerInfo().data?.forceReadOnly ?? false;
  const schemas = useSchemas();
  const saved = useRecipes();
  const saveRecipe = useWorkspaceStore((s) => s.saveRecipe);
  const removeRecipe = useWorkspaceStore((s) => s.removeRecipe);
  const [editing, setEditing] = useState(false);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [spec, setSpec] = useState<RunSpec | null>(null);
  const editorHeight = usePaneSize('recipe.editor', 260);
  const set = (patch: Partial<QueryTab>) => updateTab(tab.id, patch);

  // A fresh recipe tab starts on the first template.
  useEffect(() => {
    if (!tab.recipeText) set(loadRecipePatch(BUILTIN_RECIPES[0] as Recipe));
  }, [tab.id]);

  const draft = useMemo(() => parseDraft(tab.recipeText ?? ''), [tab.recipeText]);
  const recipe = draft.recipe;
  const db = tab.db ?? (profile ? defaultDbFromUri(profile.uri) : null);
  const savedCopy = saved.find((r) => r.id === tab.recipeId);
  const source = savedCopy ?? BUILTIN_RECIPES.find((r) => r.id === tab.recipeId);
  const dirty = !!source && recipeText(source) !== tab.recipeText;
  const params = tab.recipeParams ?? {};
  const view: RecipeViewMode = tab.recipeView ?? recipe?.view?.mode ?? 'dossier';

  const result = useQuery({
    queryKey: ['recipe', tab.id, spec],
    enabled: !!spec,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    queryFn: async (): Promise<RecipeRunResponse> => {
      const s = spec as RunSpec;
      const p = useConnectionStore.getState().profiles.find((x) => x.id === s.connectionId);
      if (!p) throw new Error('The connection for this tab no longer exists');
      return api.runRecipe(contextFor(p, forceReadOnly), { db: s.db, recipe: s.recipe, params: s.params });
    },
  });

  const run = () => {
    if (!profile || !recipe || !db) return;
    setSpec({ connectionId: profile.id, db, recipe, params, at: Date.now() });
  };

  useHotkeys({ 'mod+Enter': run, 'alt+KeyE': () => setEditing((v) => !v) }, active);

  /** Apply a structural change to the draft (pipeline editor). */
  const patchStep = (id: string, patch: Partial<RecipeStep>) => {
    if (!recipe) return;
    const next: Recipe = {
      ...recipe,
      steps: recipe.steps.map((s) => {
        if (s.id !== id) return s;
        const merged = { ...s, ...patch } as Record<string, unknown>;
        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete merged[k];
        return merged as unknown as RecipeStep;
      }),
    };
    set({ recipeText: recipeText(next) });
  };

  const load = (r: Recipe) => {
    set(loadRecipePatch(r));
    setSpec(null);
    setSelectedStep(null);
  };

  const save = () => {
    if (!recipe) return;
    if (isBuiltin(recipe.id)) return duplicate();
    saveRecipe(recipe);
    set({ recipeId: recipe.id, recipeName: recipe.name ?? recipe.id, recipeText: recipeText(recipe) });
    toast(`Recipe "${recipe.name ?? recipe.id}" saved to the workspace config`);
  };

  const duplicate = () => {
    if (!recipe) return;
    const base = recipe.id.replace(/^builtin\./, '');
    let id = base;
    for (let n = 2; saved.some((r) => r.id === id); n++) id = `${base}-${n}`;
    const copy: Recipe = { ...recipe, id, name: isBuiltin(recipe.id) ? (recipe.name ?? id) : `${recipe.name ?? id} (copy)` };
    saveRecipe(copy);
    set({ ...loadRecipePatch(copy), recipeParams: params, recipeView: tab.recipeView ?? null });
    setEditing(true);
    toast(`Saved as "${copy.name}" in the workspace config — edit it freely`);
  };

  const remove = () => {
    if (!savedCopy || !window.confirm(`Delete recipe "${savedCopy.name ?? savedCopy.id}" from the workspace config?`)) return;
    removeRecipe(savedCopy.id);
    load(BUILTIN_RECIPES[0] as Recipe);
  };

  const data = result.data;
  const ranRecipe = spec?.recipe ?? recipe;
  const selected = recipe?.steps.find((s) => s.id === selectedStep) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ModeSwitch tab={tab} />
        <RecipePicker current={tab.recipeId ?? null} saved={saved} onPick={load} onNew={() => { load(blankRecipe(tab.collection)); setEditing(true); }} />
        {dirty && <span className="text-xs text-amber-400" title="The editor differs from the saved recipe">● modified</span>}
        <Button onClick={() => setEditing(!editing)} aria-pressed={editing} title="Edit the recipe as JSON (Alt+E)">
          ✎ {editing ? 'Hide editor' : 'Edit'}
        </Button>
        {recipe && !isBuiltin(recipe.id) ? (
          <Button onClick={save} disabled={!recipe || (!dirty && !!savedCopy)} title="Save into litemongo.config.json (recipes)">
            💾 Save
          </Button>
        ) : null}
        <Button onClick={duplicate} disabled={!recipe} title="Save a copy into the workspace config to customise it">
          ⧉ {recipe && isBuiltin(recipe.id) ? 'Customise (copy)' : 'Duplicate'}
        </Button>
        {savedCopy && (
          <Button variant="ghost" onClick={remove} title="Delete this saved recipe">
            🗑
          </Button>
        )}
        <span className="font-mono text-sm text-zinc-400">
          db = <span className="text-zinc-100">{db ?? '(no database)'}</span>
        </span>
        <Button variant="primary" className="ml-auto" onClick={run} disabled={!recipe || !db || result.isFetching} title="Run (Ctrl/Cmd+Enter)">
          {result.isFetching ? 'Running…' : '▶ Run'}
        </Button>
      </div>

      {recipe?.description && <p className="text-sm text-zinc-400">{recipe.description}</p>}

      {recipe && (recipe.params ?? []).length > 0 && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          {(recipe.params ?? []).map((p) => (
            <label key={p.name} className="flex flex-col gap-0.5 text-xs text-zinc-400">
              <span>
                {p.label ?? p.name}
                {p.required && <span className="text-red-400"> *</span>}
                <span className="ml-1 font-mono text-zinc-600">{`{{${p.name}}}`}</span>
              </span>
              <input
                className={`${inputClass} w-48`}
                list={p.options ? `${tab.id}-${p.name}-options` : undefined}
                type={p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text'}
                value={params[p.name] ?? ''}
                placeholder={p.required ? 'required' : 'any'}
                onChange={(e) => set({ recipeParams: { ...params, [p.name]: e.target.value } })}
              />
              {p.options && (
                <datalist id={`${tab.id}-${p.name}-options`}>
                  {p.options.map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              )}
            </label>
          ))}
          <button type="submit" className="hidden" />
        </form>
      )}

      {recipe && <Pipeline recipe={recipe} selected={selectedStep} onSelect={(id) => setSelectedStep(id === selectedStep ? null : id)} stats={data?.recipeId === recipe.id ? data : undefined} />}
      {selected && recipe && <StepTuner recipe={recipe} step={selected} onChange={(patch) => patchStep(selected.id, patch)} onClose={() => setSelectedStep(null)} />}

      {editing && (
        <>
          <div className="grid shrink-0" style={{ height: editorHeight }}>
            <JsonEditor
              path={`${tab.id}/recipe.json`}
              label="Recipe (JSON) — steps, strategies, {{params}}, display"
              value={tab.recipeText ?? ''}
              onChange={(recipeTextValue) => set({ recipeText: recipeTextValue })}
              onRun={run}
              actions={draft.error ? <span className="text-red-400">invalid</span> : <span className="text-emerald-400">valid</span>}
            />
          </div>
          <Splitter sizeKey="recipe.editor" size={editorHeight} min={120} label="Resize recipe editor" />
        </>
      )}
      {draft.error && <ErrorBox error={draft.error} />}
      {result.isError && <ErrorBox error={result.error} />}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className="flex overflow-hidden rounded border border-zinc-700" role="group" aria-label="Presentation">
          {VIEWS.map(({ mode, label, title }) => (
            <button
              key={mode}
              type="button"
              title={title}
              aria-pressed={view === mode}
              onClick={() => set({ recipeView: mode })}
              className={`px-2.5 py-1 ${view === mode ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {view === 'board' && ranRecipe && (
          <GroupByPicker recipe={ranRecipe} value={groupByOf(ranRecipe)} sample={data?.roots[0]?.doc} onChange={(groupBy) => recipe && set({ recipeText: recipeText({ ...recipe, view: { ...recipe.view, groupBy } }) })} />
        )}
        {data && (
          <span className="text-zinc-400">
            {data.roots.length} root{data.roots.length === 1 ? '' : 's'} · {data.queries} queries · {data.totalMs} ms
          </span>
        )}
        {data?.warnings.map((w) => (
          <span key={w} className="text-xs text-amber-400">
            ⚠ {w}
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded border border-zinc-800">
        {!data && !result.isFetching && (
          <div className="p-4 text-sm text-zinc-500">
            {profile ? 'Fill in the parameters and press Run (Ctrl/Cmd+Enter).' : 'Select a connection first.'}
          </div>
        )}
        {result.isFetching && !data && <div className="p-4 text-sm text-zinc-500">Running…</div>}
        {data && ranRecipe && view === 'dossier' && <DossierView recipe={ranRecipe} result={data} schemas={schemas} />}
        {data && ranRecipe && view === 'board' && <BoardView recipe={ranRecipe} result={data} schemas={schemas} groupBy={groupByOf(recipe ?? ranRecipe)} />}
        {data && ranRecipe && view === 'trace' && <TraceView recipe={ranRecipe} result={data} />}
        {data && view === 'json' && <JsonView result={data} />}
      </div>
    </div>
  );
}

function groupByOf(recipe: Recipe): string {
  return recipe.view?.groupBy ?? 'status';
}

function RecipePicker({ current, saved, onPick, onNew }: { current: string | null; saved: Recipe[]; onPick: (r: Recipe) => void; onNew: () => void }) {
  const all = [...BUILTIN_RECIPES, ...saved];
  const currentRecipe = all.find((r) => r.id === current);
  return (
    <Dropdown label={<span className="text-sm">⚗ {currentRecipe?.name ?? current ?? 'Recipe'}</span>} title="Recipes: ready-made templates and your saved ones" width={420}>
      {(close) => (
        <div className="flex flex-col gap-1">
          <Group title="Templates" recipes={BUILTIN_RECIPES} current={current} onPick={(r) => { onPick(r); close(); }} />
          <Group title="Saved in workspace config" recipes={saved} current={current} onPick={(r) => { onPick(r); close(); }} empty="None yet — use “Customise (copy)” on a template." />
          <button type="button" className="mt-1 rounded px-2 py-1 text-left text-emerald-400 hover:bg-zinc-800" onClick={() => { onNew(); close(); }}>
            + New blank recipe
          </button>
        </div>
      )}
    </Dropdown>
  );
}

function Group({ title, recipes, current, onPick, empty }: { title: string; recipes: Recipe[]; current: string | null; onPick: (r: Recipe) => void; empty?: string }) {
  return (
    <div>
      <div className="px-2 pt-1 pb-0.5 text-[10px] tracking-wide text-zinc-500 uppercase">{title}</div>
      {recipes.length === 0 && empty && <div className="px-2 py-1 text-zinc-500">{empty}</div>}
      {recipes.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onPick(r)}
          className={`flex w-full flex-col rounded px-2 py-1 text-left hover:bg-zinc-800 ${r.id === current ? 'bg-zinc-800' : ''}`}
        >
          <span className="text-sm text-zinc-100">{r.name ?? r.id}</span>
          {r.description && <span className="line-clamp-2 text-zinc-500">{r.description}</span>}
          <span className="mt-0.5 font-mono text-[10px] text-zinc-500">{r.steps.map((s) => s.collection).join(' → ')}</span>
        </button>
      ))}
    </div>
  );
}

/** The plan as a strip of step chips (tree order, parents named); click one to tune it. */
function Pipeline({ recipe, selected, onSelect, stats }: { recipe: Recipe; selected: string | null; onSelect: (id: string) => void; stats: RecipeRunResponse | undefined }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Fetch plan">
      {recipe.steps.map((s, i) => {
        const color = stepColor(recipe, s.id);
        const st = stats?.steps.find((x) => x.step === s.id);
        const parent = s.parent ? recipe.steps.find((x) => x.id === s.parent) : undefined;
        return (
          <div key={s.id} className="flex items-center gap-1.5">
            {i > 0 && (
              <span className="text-zinc-600" title={parent ? `fed by ${parent.label ?? parent.id}` : undefined}>
                {s.parent === recipe.steps[i - 1]?.id ? '→' : `↳ ${parent?.label ?? s.parent}:`}
              </span>
            )}
            <button
              type="button"
              onClick={() => onSelect(s.id)}
              aria-pressed={selected === s.id}
              title={`${STRATEGY_HELP[i === 0 ? 'root' : (s.strategy ?? 'in')]}\nClick to tune this step.`}
              className={`flex items-center gap-1.5 rounded border px-2 py-1 ${selected === s.id ? 'border-zinc-400 bg-zinc-800' : `${color.border} bg-zinc-900 hover:bg-zinc-800`}`}
            >
              <span className={`h-2 w-2 rounded-full ${color.dot}`} />
              <span className="text-zinc-100">{s.label ?? s.id}</span>
              <span className="font-mono text-zinc-500">{s.collection}</span>
              <span className={`font-mono ${color.text}`}>{strategyLabel(s, i === 0)}</span>
              {st && (
                <span className="rounded bg-black/30 px-1 text-zinc-300 tabular-nums" title={`${st.queries} queries · ${st.docs} docs · ${st.ms} ms`}>
                  {st.docs}
                  {st.truncated ? '+' : ''} · {st.queries}q · {st.ms}ms
                </span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

const numberInput = `${inputClass} w-20`;

/** Inline editor for one step's algorithm and presentation. */
function StepTuner({ recipe, step, onChange, onClose }: { recipe: Recipe; step: RecipeStep; onChange: (patch: Partial<RecipeStep>) => void; onClose: () => void }) {
  const isRoot = recipe.steps[0]?.id === step.id;
  const strategy = step.strategy ?? 'in';
  const num = (key: 'limit' | 'batchSize' | 'concurrency' | 'maxParents', label: string, placeholder: string, title: string) => (
    <label className="flex items-center gap-1" title={title}>
      {label}
      <input
        type="number"
        min={1}
        className={numberInput}
        placeholder={placeholder}
        value={step[key] ?? ''}
        onChange={(e) => onChange({ [key]: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })}
      />
    </label>
  );
  const setStrategy = (next: RecipeStrategy) => {
    const patch: Partial<RecipeStep> = { strategy: next };
    if (next !== 'batched') patch.batchSize = undefined;
    if (next !== 'nested-loop') patch.maxParents = undefined;
    if (next === 'nested-loop' && strategy !== 'nested-loop') patch.limit = 10;
    if (next !== 'nested-loop' && strategy === 'nested-loop') patch.limit = undefined;
    onChange(patch);
  };
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded border bg-zinc-900 px-3 py-2 text-xs text-zinc-400 ${stepColor(recipe, step.id).border}`}>
      <span className="font-semibold text-zinc-100">{step.label ?? step.id}</span>
      {isRoot ? (
        num('limit', 'Fetch', '50', 'Root documents fetched')
      ) : (
        <>
          <div className="flex overflow-hidden rounded border border-zinc-700" role="group" aria-label="Fetch algorithm">
            {(['in', 'batched', 'nested-loop'] as const).map((s) => (
              <button
                key={s}
                type="button"
                title={STRATEGY_HELP[s]}
                aria-pressed={strategy === s}
                onClick={() => setStrategy(s)}
                disabled={s !== 'nested-loop' && !step.localField}
                className={`px-2 py-0.5 disabled:opacity-40 ${strategy === s ? 'bg-zinc-700 text-zinc-50' : 'hover:bg-zinc-800'}`}
              >
                {s === 'in' ? '⇉ single $in' : s === 'batched' ? '▦ batched' : '↻ nested loop'}
              </button>
            ))}
          </div>
          {step.localField && (
            <span className="font-mono">
              {recipe.steps.find((s) => s.id === step.parent)?.collection}.{step.localField} = {step.collection}.{step.foreignField}
            </span>
          )}
          {strategy === 'batched' && num('batchSize', 'Packet', '100', 'Keys per $in query')}
          {strategy !== 'in' && num('concurrency', 'Parallel', strategy === 'batched' ? '1' : '4', 'Queries in flight at once')}
          {strategy === 'nested-loop' ? num('limit', 'Per parent', '10', 'Documents per parent (with the step sort)') : num('limit', 'Cap', '5000', 'Total documents for this step')}
          {strategy === 'nested-loop' && num('maxParents', 'Max parents', '200', 'Parents that get a query; the rest are skipped')}
        </>
      )}
      <label className="flex items-center gap-1">
        Layout
        <select
          className={inputClass}
          value={step.display?.layout ?? 'cards'}
          onChange={(e) => onChange({ display: { ...step.display, layout: e.target.value as 'cards' | 'table' | 'chips' } })}
        >
          <option value="cards">cards</option>
          <option value="table">table</option>
          <option value="chips">chips</option>
        </select>
      </label>
      <button type="button" className="ml-auto text-zinc-500 hover:text-zinc-200" onClick={onClose} aria-label="Close step settings">
        ✕
      </button>
    </div>
  );
}

function GroupByPicker({ recipe, value, sample, onChange }: { recipe: Recipe; value: string; sample: Record<string, unknown> | undefined; onChange: (v: string) => void }) {
  const fields = Array.from(new Set([value, ...(recipe.steps[0]?.display?.fields ?? []), ...Object.keys(sample ?? {})])).filter((f) => f !== '_id');
  return (
    <label className="flex items-center gap-1 text-xs text-zinc-400">
      Columns by
      <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
        {fields.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </label>
  );
}
