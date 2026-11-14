/**
 * Single source of BSON classes for the server.
 *
 * Always import BSON types from here, never from 'bson' directly: our ESM code
 * would load bson's ESM build while the (CommonJS) mongodb driver loads the CJS
 * build, giving two different ObjectId/Decimal128/... classes and breaking
 * `instanceof` checks on documents read from the database.
 */
import { BSON } from 'mongodb';

export { Binary, Decimal128, Double, Int32, Long, ObjectId, UUID } from 'mongodb';
export const EJSON = BSON.EJSON;
