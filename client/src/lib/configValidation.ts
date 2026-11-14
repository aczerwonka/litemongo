import { FIELD_TYPES } from './schema';

/**
 * Validation of litemongo.config.json for the in-app config editor. Collects
 * every problem (instead of stopping at the first) with a JSON path, so the
 * editor can list them all. Errors block "Apply"; warnings do not.
 */

export interface ConfigIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
  /** 1-based position, for JSON syntax errors. */
  line?: number;
  column?: number;
}

export interface ValidationResult {
  issues: ConfigIssue[];
  parsed: unknown;
  ok: boolean;
}

const TOP_LEVEL = new Set(['version', 'workspaceName', 'schemas', 'relationBlueprints', 'renumberingRules', 'queryPresets']);
const STRATEGIES = new Set(['SUFFIX_TIMESTAMP', 'UUID_SHORT', 'KEEP', 'OFFSET']);
const KNOWN_TYPES = new Set<string>(FIELD_TYPES);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Line / column of a JSON.parse error (V8 reports either a position or line+column). */
function syntaxPosition(text: string, message: string): { line: number; column: number } | undefined {
  const lc = /line (\d+) column (\d+)/i.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/i.exec(message);
  if (!pos) return undefined;
  const before = text.slice(0, Number(pos[1]));
  const lines = before.split('\n');
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

export function validateConfigText(text: string): ValidationResult {
  if (!text.trim()) {
    return { issues: [{ severity: 'error', path: '$', message: 'Config is empty' }], parsed: undefined, ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = (err as Error).message;
    const pos = syntaxPosition(text, message);
    return { issues: [{ severity: 'error', path: '$', message: `Invalid JSON: ${message}`, ...pos }], parsed: undefined, ok: false };
  }
  const issues = validateConfig(parsed);
  return { issues, parsed, ok: !issues.some((i) => i.severity === 'error') };
}

export function validateConfig(cfg: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const error = (path: string, message: string) => issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ severity: 'warning', path, message });
  const stringList = (v: unknown, path: string) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) error(path, 'must be an array of strings');
  };

  if (!isRecord(cfg)) {
    error('$', 'Config must be a JSON object');
    return issues;
  }
  for (const key of Object.keys(cfg)) if (!TOP_LEVEL.has(key)) warn(key, 'unknown top-level key (ignored)');
  if (cfg.workspaceName !== undefined && typeof cfg.workspaceName !== 'string') error('workspaceName', 'must be a string');
  if (cfg.version !== undefined && typeof cfg.version !== 'string') error('version', 'must be a string');

  // schemas
  if (cfg.schemas !== undefined) {
    if (!isRecord(cfg.schemas)) error('schemas', 'must be an object keyed by collection name');
    else {
      for (const [coll, schema] of Object.entries(cfg.schemas)) {
        const base = `schemas.${coll}`;
        if (!isRecord(schema)) {
          error(base, 'must be an object');
          continue;
        }
        if (schema.description !== undefined && typeof schema.description !== 'string') error(`${base}.description`, 'must be a string');
        if (schema.displayBadgeField !== undefined && typeof schema.displayBadgeField !== 'string') error(`${base}.displayBadgeField`, 'must be a string');
        stringList(schema.idPaths, `${base}.idPaths`);
        stringList(schema.protectedCodePaths, `${base}.protectedCodePaths`);
        if (schema.foreignKeys !== undefined) {
          if (!isRecord(schema.foreignKeys)) error(`${base}.foreignKeys`, 'must be an object { localPath: "collection.path" }');
          else
            for (const [p, target] of Object.entries(schema.foreignKeys)) {
              if (typeof target !== 'string' || !/^[^.]+\..+/.test(target)) error(`${base}.foreignKeys.${p}`, 'must be "collection.path"');
            }
        }
        if (schema.coreFields !== undefined) {
          if (!isRecord(schema.coreFields)) error(`${base}.coreFields`, 'must be an object of field definitions');
          else validateFields(schema.coreFields, `${base}.coreFields`, error, warn);
        }
      }
    }
  }

  // relationBlueprints
  const blueprintIds = new Set<string>();
  if (cfg.relationBlueprints !== undefined) {
    if (!Array.isArray(cfg.relationBlueprints)) error('relationBlueprints', 'must be an array');
    else
      cfg.relationBlueprints.forEach((b, i) => {
        const base = `relationBlueprints[${i}]`;
        if (!isRecord(b)) return error(base, 'must be an object');
        if (typeof b.id !== 'string' || !b.id) error(`${base}.id`, 'required string');
        else if (blueprintIds.has(b.id)) error(`${base}.id`, `duplicate id "${b.id}"`);
        else blueprintIds.add(b.id);
        if (typeof b.rootCollection !== 'string' || !b.rootCollection) error(`${base}.rootCollection`, 'required string');
        if (!Array.isArray(b.levels)) return error(`${base}.levels`, 'required array');
        b.levels.forEach((l, j) => {
          const lp = `${base}.levels[${j}]`;
          if (!isRecord(l)) return error(lp, 'must be an object');
          for (const key of ['collection', 'localField', 'foreignField'] as const) {
            if (typeof l[key] !== 'string' || !l[key]) error(`${lp}.${key}`, 'required string');
          }
          if (l.level !== undefined && (typeof l.level !== 'number' || l.level < 2 || l.level > 3)) error(`${lp}.level`, 'must be 2 or 3');
          if (l.parentCollection !== undefined && typeof l.parentCollection !== 'string') error(`${lp}.parentCollection`, 'must be a string');
        });
      });
  }

  // queryPresets
  if (cfg.queryPresets !== undefined) {
    if (!Array.isArray(cfg.queryPresets)) error('queryPresets', 'must be an array');
    else {
      const ids = new Set<string>();
      cfg.queryPresets.forEach((p, i) => {
        const base = `queryPresets[${i}]`;
        if (!isRecord(p)) return error(base, 'must be an object');
        if (typeof p.id !== 'string' || !p.id) error(`${base}.id`, 'required string');
        else if (ids.has(p.id)) error(`${base}.id`, `duplicate id "${p.id}"`);
        else ids.add(p.id);
        if (typeof p.collection !== 'string' || !p.collection) error(`${base}.collection`, 'required string');
        if (p.name !== undefined && typeof p.name !== 'string') error(`${base}.name`, 'must be a string');
        for (const key of ['filter', 'projection', 'sort'] as const) {
          if (p[key] !== undefined && !isRecord(p[key])) error(`${base}.${key}`, 'must be an object');
        }
        if (p.limit !== undefined && (typeof p.limit !== 'number' || !Number.isInteger(p.limit) || p.limit < 1)) error(`${base}.limit`, 'must be a positive integer');
        if (p.relationBlueprintId !== undefined) {
          if (typeof p.relationBlueprintId !== 'string') error(`${base}.relationBlueprintId`, 'must be a string');
          else if (!blueprintIds.has(p.relationBlueprintId)) warn(`${base}.relationBlueprintId`, `no relation blueprint with id "${p.relationBlueprintId}"`);
        }
      });
    }
  }

  // renumberingRules
  if (cfg.renumberingRules !== undefined) {
    if (!isRecord(cfg.renumberingRules)) error('renumberingRules', 'must be an object { collection: { path: rule } }');
    else
      for (const [coll, rules] of Object.entries(cfg.renumberingRules)) {
        if (!isRecord(rules)) {
          error(`renumberingRules.${coll}`, 'must be an object { path: rule }');
          continue;
        }
        for (const [p, rule] of Object.entries(rules)) {
          const rp = `renumberingRules.${coll}.${p}`;
          if (!isRecord(rule)) {
            error(rp, 'must be an object { strategy, prefix?, offset? }');
            continue;
          }
          if (typeof rule.strategy !== 'string' || !STRATEGIES.has(rule.strategy)) error(`${rp}.strategy`, `must be one of ${[...STRATEGIES].join(', ')}`);
          if (rule.prefix !== undefined && typeof rule.prefix !== 'string') error(`${rp}.prefix`, 'must be a string');
          if (rule.offset !== undefined && typeof rule.offset !== 'number') error(`${rp}.offset`, 'must be a number');
          if (rule.strategy === 'OFFSET' && typeof rule.offset !== 'number') error(`${rp}.offset`, 'required for strategy OFFSET');
        }
      }
  }
  return issues;
}

function validateFields(
  fields: Record<string, unknown>,
  base: string,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): void {
  for (const [name, def] of Object.entries(fields)) {
    const p = `${base}.${name}`;
    if (!isRecord(def)) {
      error(p, 'must be a field definition object');
      continue;
    }
    if (def.type !== undefined) {
      if (typeof def.type !== 'string') error(`${p}.type`, 'must be a string');
      else if (!KNOWN_TYPES.has(def.type)) warn(`${p}.type`, `unknown type "${def.type}" (known: ${FIELD_TYPES.join(', ')})`);
    }
    if (def.enum !== undefined && (!Array.isArray(def.enum) || def.enum.some((v) => typeof v !== 'string'))) error(`${p}.enum`, 'must be an array of strings');
    if (def.description !== undefined && typeof def.description !== 'string') error(`${p}.description`, 'must be a string');
    if (def.items !== undefined) {
      if (!isRecord(def.items)) error(`${p}.items`, 'must be an object of field definitions');
      else validateFields(def.items, `${p}.items`, error, warn);
      if (def.type !== undefined && def.type !== 'array') warn(`${p}.items`, '"items" is used with type "array"');
    }
    if (def.fields !== undefined) {
      if (!isRecord(def.fields)) error(`${p}.fields`, 'must be an object of field definitions');
      else validateFields(def.fields, `${p}.fields`, error, warn);
    }
  }
}
