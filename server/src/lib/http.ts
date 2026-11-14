import { EJSON } from './bson.js';
import type { Document } from 'mongodb';

/** Error carrying an HTTP status; message is safe to return to the client. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`"${field}" must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`"${field}" must be a non-empty string`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest(`"${field}" must be a string`);
  return value;
}

export function boundedInt(
  body: Record<string, unknown>,
  field: string,
  { fallback, min, max }: { fallback: number; min: number; max: number },
): number {
  const value = body[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest(`"${field}" must be an integer`);
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * Parse a query fragment (filter / projection / sort) sent by the client as an
 * Extended JSON object, e.g. { "_id": { "$oid": "..." } }, into BSON-typed values.
 * Canonical mode keeps Int32/Long/Double distinctions intact.
 */
export function ejsonDocument(body: Record<string, unknown>, field: string): Document {
  const raw = body[field];
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {};
    try {
      const parsed: unknown = EJSON.parse(raw, { relaxed: false });
      return asRecord(parsed, field) as Document;
    } catch (err) {
      throw badRequest(`"${field}" is not valid Extended JSON: ${(err as Error).message}`);
    }
  }
  try {
    return asRecord(EJSON.deserialize(asRecord(raw, field), { relaxed: false }), field) as Document;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest(`"${field}" is not valid Extended JSON: ${(err as Error).message}`);
  }
}

/** Serialize BSON values for an API response in canonical EJSON (lossless). */
export function toEjson(value: unknown): unknown {
  return EJSON.serialize(value, { relaxed: false });
}
