import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, maskUri } from '../lib/api';
import {
  buildUri,
  DEFAULT_PARAMS,
  ENV_KINDS,
  ENV_STYLES,
  isLockedEnv,
  newId,
  parseUri,
  useConnectionStore,
  type ConnectionParams,
  type ConnectionProfile,
  type EnvKind,
} from '../store/useConnectionStore';
import { Button, ErrorBox, Field, inputClass, Modal } from './ui';

type Mode = 'params' | 'uri';

export function ConnectionDialog({
  profile,
  onClose,
  onSaved,
}: {
  profile?: ConnectionProfile;
  onClose: () => void;
  onSaved?: (profile: ConnectionProfile) => void;
}) {
  const upsert = useConnectionStore((s) => s.upsert);
  const [draft, setDraft] = useState<ConnectionProfile>(
    profile ?? { id: newId(), name: '', uri: '', env: 'local', readOnly: false },
  );
  // New profiles start with the parameter form; existing ones keep the way they were made.
  const [mode, setMode] = useState<Mode>(profile && !profile.params ? 'uri' : 'params');
  const [params, setParams] = useState<ConnectionParams>(profile?.params ?? DEFAULT_PARAMS);

  const uri = mode === 'params' ? buildUri(params) : draft.uri.trim();
  const test = useMutation({
    mutationFn: () => api.testConnection({ uri, readOnly: true }),
  });

  const setEnv = (env: EnvKind) =>
    // PROD / CLIENT are always read-only; switching to TEST/DEV/LOCAL keeps the user's choice.
    setDraft((d) => ({ ...d, env, readOnly: isLockedEnv(env) ? true : d.readOnly }));

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    if (next === 'uri') setDraft((d) => ({ ...d, uri: buildUri(params) }));
    else {
      const parsed = draft.uri.trim() ? parseUri(draft.uri) : null;
      if (parsed) setParams(parsed);
    }
    test.reset();
    setMode(next);
  };

  const setParam = <K extends keyof ConnectionParams>(key: K, value: ConnectionParams[K]) => {
    setParams((p) => ({ ...p, [key]: value }));
    test.reset();
  };

  const uriOk = mode === 'params' ? params.host.trim() !== '' : /^mongodb(\+srv)?:\/\//i.test(draft.uri.trim());
  const valid = draft.name.trim() !== '' && uriOk;
  const locked = isLockedEnv(draft.env);

  const save = () => {
    const saved: ConnectionProfile = {
      id: draft.id,
      name: draft.name.trim(),
      uri,
      env: draft.env,
      readOnly: draft.readOnly || locked,
      ...(mode === 'params' ? { params } : {}),
    };
    upsert(saved);
    onSaved?.(saved);
    onClose();
  };

  return (
    <Modal
      title={profile ? 'Edit connection' : 'New connection'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => test.mutate()} disabled={!uriOk || test.isPending}>
            {test.isPending ? 'Testing…' : 'Test'}
          </Button>
          <Button variant="primary" onClick={save} disabled={!valid}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save();
        }}
      >
        <Field label="Name">
          <input
            className={inputClass}
            value={draft.name}
            placeholder="Local Docker Dev"
            autoFocus
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>

        <div className="flex overflow-hidden self-start rounded border border-zinc-700 text-sm" role="tablist" aria-label="Connection input">
          {(
            [
              ['params', 'Parameters'],
              ['uri', 'Connection string'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => switchMode(m)}
              className={`px-3 py-1 ${mode === m ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'params' ? (
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <Field label={params.srv ? 'Host (SRV record)' : 'Host'} hint="Several hosts: comma-separated (host1:27017,host2:27017)">
              <input
                className={`${inputClass} font-mono`}
                value={params.host}
                spellCheck={false}
                placeholder="localhost"
                onChange={(e) => setParam('host', e.target.value)}
              />
            </Field>
            <Field label="Port">
              <input
                className={`${inputClass} font-mono`}
                value={params.srv ? '' : params.port}
                disabled={params.srv}
                inputMode="numeric"
                placeholder={params.srv ? '—' : '27017'}
                onChange={(e) => setParam('port', e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <Field label="Username">
              <input
                className={`${inputClass} font-mono`}
                value={params.username}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setParam('username', e.target.value)}
              />
            </Field>
            <Field label="Auth DB">
              <input
                className={`${inputClass} font-mono`}
                value={params.authSource}
                spellCheck={false}
                placeholder="admin"
                onChange={(e) => setParam('authSource', e.target.value)}
              />
            </Field>
            <div className="col-span-2">
              <Field label="Password">
                <input
                  className={`${inputClass} font-mono`}
                  type="password"
                  value={params.password}
                  autoComplete="new-password"
                  onChange={(e) => setParam('password', e.target.value)}
                />
              </Field>
            </div>
            <div className="col-span-2">
              <Field label="Default database (optional)">
                <input
                  className={`${inputClass} font-mono`}
                  value={params.database}
                  spellCheck={false}
                  placeholder="insurance_dev"
                  onChange={(e) => setParam('database', e.target.value)}
                />
              </Field>
            </div>
            <div className="col-span-2 flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={params.srv} onChange={(e) => setParam('srv', e.target.checked)} />
                SRV (mongodb+srv, Atlas)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={params.tls || params.srv} disabled={params.srv} onChange={(e) => setParam('tls', e.target.checked)} />
                TLS
              </label>
            </div>
            <div className="col-span-2 truncate rounded bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-500" title="Resulting connection string">
              {maskUri(uri)}
            </div>
          </div>
        ) : (
          <Field
            label="Connection string"
            hint="Stored only in this browser's localStorage and sent per request. The server never saves it."
          >
            <input
              className={`${inputClass} font-mono`}
              value={draft.uri}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="mongodb://user:pass@localhost:27017/insurance_dev?authSource=admin"
              onChange={(e) => {
                setDraft({ ...draft, uri: e.target.value });
                test.reset();
              }}
            />
          </Field>
        )}

        <Field label="Environment">
          <div className="flex flex-wrap gap-2">
            {ENV_KINDS.map((env) => (
              <button
                key={env}
                type="button"
                onClick={() => setEnv(env)}
                aria-pressed={draft.env === env}
                className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-semibold ${draft.env === env ? `${ENV_STYLES[env].border} bg-zinc-800` : 'border-zinc-700'}`}
              >
                <span className={`h-2.5 w-2.5 rounded-full ${ENV_STYLES[env].dot}`} />
                {ENV_STYLES[env].label}
                {ENV_STYLES[env].locked && <span title="Always read-only">🔒</span>}
              </button>
            ))}
          </div>
        </Field>
        <label className={`flex items-center gap-2 text-sm ${locked ? 'text-zinc-500' : ''}`}>
          <input
            type="checkbox"
            checked={draft.readOnly || locked}
            disabled={locked}
            onChange={(e) => setDraft({ ...draft, readOnly: e.target.checked })}
          />
          Read-only (blocks paste and every other write on the server)
          {locked && ' — always on for PROD / CLIENT'}
        </label>
        {test.isSuccess && (
          <div className="rounded border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">
            Connected: MongoDB {test.data.serverVersion}, {test.data.pingMs} ms ping
            {test.data.defaultDb ? `, default db "${test.data.defaultDb}"` : ''}.
          </div>
        )}
        <ErrorBox error={test.error} />
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
