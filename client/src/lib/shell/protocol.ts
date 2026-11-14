/** Messages between the script-mode UI and its Web Worker. */

export interface RunRequest {
  type: 'run';
  script: string;
  db: string;
  uri: string;
  readOnly: boolean;
  /** Documents shown when the script's result is an unlimited cursor. */
  displayLimit: number;
}

export type ShellResult =
  /** Iterable result: shown in the Tree / Table viewer. Canonical EJSON. */
  | { kind: 'docs'; docs: Record<string, unknown>[]; hasMore: boolean; label: string }
  /** Any other value: shown in the console. */
  | { kind: 'value'; text: string }
  | { kind: 'none' };

export type WorkerMessage =
  | { type: 'print'; text: string; level: 'log' | 'warn' | 'error' }
  | { type: 'op'; op: string; collection: string | null; ms: number; count?: number }
  | { type: 'done'; result: ShellResult; ms: number }
  | { type: 'error'; message: string; line?: number };
