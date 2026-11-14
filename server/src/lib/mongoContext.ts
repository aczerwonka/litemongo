import type { FastifyRequest } from 'fastify';
import type { Db } from 'mongodb';
import { getClient } from '../db/connection.js';
import { badRequest } from './http.js';

/** Read the per-request connection string. It is used, never stored or logged. */
export function mongoUriFrom(request: FastifyRequest): string {
  const header = request.headers['x-mongo-uri'];
  const uri = Array.isArray(header) ? header[0] : header;
  if (!uri) throw badRequest('Missing X-Mongo-URI header');
  return uri;
}

/** Database name embedded in the URI path, e.g. mongodb://host/insurance_dev?authSource=admin. */
export function defaultDbFromUri(uri: string): string | undefined {
  const match = /^mongodb(?:\+srv)?:\/\/[^/?]+\/([^?]+)/i.exec(uri);
  const name = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  return name || undefined;
}

export async function dbFor(request: FastifyRequest, dbName?: string): Promise<Db> {
  const uri = mongoUriFrom(request);
  const name = dbName ?? defaultDbFromUri(uri);
  if (!name) {
    throw badRequest('No database selected: pass "db" or include it in the connection string path');
  }
  const client = await getClient(uri);
  return client.db(name);
}
