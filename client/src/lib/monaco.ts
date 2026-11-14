/**
 * Bundle Monaco locally instead of letting @monaco-editor/react fetch it from a
 * CDN: jump hosts often have no outbound internet, and the PWA must work offline.
 * Only the editor core + JSON language are included to keep the bundle lean.
 */
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import './monacoContrib';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register';
// Script mode: JavaScript syntax highlighting only (Monarch tokenizer, no TS worker).
import 'monaco-editor/languages/definitions/javascript/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    return label === 'json' ? new JsonWorker() : new EditorWorker();
  },
};

// Queries accept shell helpers (ObjectId("…"), ISODate("…")) and unquoted keys,
// which strict JSON validation would flag. We parse and report errors ourselves.
jsonDefaults.setDiagnosticsOptions({ validate: false, allowComments: true });

loader.config({ monaco });

export { monaco };
