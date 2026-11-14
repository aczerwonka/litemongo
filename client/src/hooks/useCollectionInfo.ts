import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/api';
import { SAMPLE_DEFAULTS } from '../lib/fieldCatalog';
import { fieldMapOf, flattenFields, inferFields } from '../lib/schema';
import { contextFor, type ConnectionProfile } from '../store/useConnectionStore';
import { useSchema } from '../store/useWorkspaceStore';
import { useServerInfo } from '../components/ui';

/** Collection names of a database (shares its cache with the sidebar browser). */
export function useCollectionNames(profile: ConnectionProfile | undefined, db: string | null): string[] {
  const forceReadOnly = useServerInfo().data?.forceReadOnly ?? false;
  const query = useQuery({
    queryKey: ['collections', profile?.id, profile?.uri, db],
    queryFn: () => api.collections(contextFor(profile as ConnectionProfile, forceReadOnly), db as string),
    enabled: !!profile && !!db,
    staleTime: 60_000,
  });
  return query.data?.collections ?? EMPTY;
}
const EMPTY: string[] = [];

/**
 * Field paths one can expect in a collection: everything documented in the
 * schema plus what a sample of real documents (first / last / random by _id) carries (dotted paths).
 */
export function useKnownFields(profile: ConnectionProfile | undefined, db: string | null, collection: string | null | undefined): string[] {
  const forceReadOnly = useServerInfo().data?.forceReadOnly ?? false;
  const schema = useSchema(collection);
  const sample = useQuery({
    queryKey: ['sample', profile?.id, profile?.uri, db, collection],
    queryFn: () =>
      api.sample(contextFor(profile as ConnectionProfile, forceReadOnly), {
        db: db as string,
        collection: collection as string,
        ...SAMPLE_DEFAULTS,
      }),
    enabled: !!profile && !!db && !!collection,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const paths = new Set<string>(['_id']);
    for (const f of flattenFields(fieldMapOf(schema))) paths.add(f.mongoPath);
    for (const f of flattenFields(inferFields(sample.data?.documents ?? []).fields)) paths.add(f.mongoPath);
    return [...paths];
  }, [schema, sample.data]);
}
