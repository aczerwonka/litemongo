import { useQuery } from '@tanstack/react-query';
import { api, type MasterDetailResponse } from '../lib/api';
import { contextFor, useConnectionStore } from '../store/useConnectionStore';
import type { QueryTab, RunSpec } from '../store/useTabStore';
import type { EjsonDoc, MasterDetailNode } from '../types';

export interface RunResult {
  spec: RunSpec;
  docs: EjsonDoc[];
  /** Present for master-detail runs; parallel to `docs`. */
  nodes: MasterDetailNode[] | null;
  hasMore: boolean;
  ms: number;
  stats: MasterDetailResponse['stats'] | null;
}

/** Executes the tab's last Run. Results stay cached per (tab, run) across tab switches. */
export function useRunResult(tab: QueryTab, forceReadOnly: boolean) {
  const spec = tab.lastRun;
  return useQuery({
    queryKey: ['run', tab.id, spec],
    enabled: !!spec,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    queryFn: async (): Promise<RunResult> => {
      const s = spec as RunSpec;
      const profile = useConnectionStore.getState().profiles.find((p) => p.id === s.connectionId);
      if (!profile) throw new Error('The connection for this tab no longer exists');
      const conn = contextFor(profile, forceReadOnly);
      const blueprint =
        s.levels.length > 0 ? { id: s.blueprintId ?? 'adhoc', rootCollection: s.collection, levels: s.levels } : undefined;

      if (blueprint) {
        const res = await api.masterDetail(conn, {
          db: s.db,
          blueprint,
          filter: s.filter,
          projection: s.projection,
          sort: s.sort,
          limit: s.limit,
        });
        return {
          spec: s,
          docs: res.roots.map((n) => n.doc),
          nodes: res.roots,
          hasMore: false,
          ms: res.stats.totalMs,
          stats: res.stats,
        };
      }
      const res = await api.find(conn, {
        db: s.db,
        collection: s.collection,
        filter: s.filter,
        projection: s.projection,
        sort: s.sort,
        limit: s.limit,
      });
      return { spec: s, docs: res.documents, nodes: null, hasMore: res.hasMore, ms: res.ms, stats: null };
    },
  });
}
