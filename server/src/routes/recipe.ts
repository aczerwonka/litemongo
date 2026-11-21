import type { FastifyInstance } from 'fastify';
import { RecipeInputError, recipeDb, runRecipe } from '../db/recipeRunner.js';
import { asRecord, badRequest, optionalString, toEjson } from '../lib/http.js';
import { dbFor } from '../lib/mongoContext.js';
import { parseRecipe } from '../lib/recipe.js';

/**
 * Fetch recipes: run a saved multi-step plan (root find + child steps fetched by
 * single $in, batched $in packets or a per-parent nested loop). Read-only: the
 * runner only ever issues find().
 */
export async function recipeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/recipe/run', async (request) => {
    const body = asRecord(request.body, 'body');
    let recipe;
    try {
      recipe = parseRecipe(body.recipe);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    const params = asRecord(body.params, 'params');
    const db = await dbFor(request, optionalString(body, 'db'));
    try {
      const result = await runRecipe(recipeDb(db), recipe, { params });
      return { db: db.databaseName, ...result, roots: toEjson(result.roots) };
    } catch (err) {
      if (err instanceof RecipeInputError) throw badRequest(err.message);
      throw err;
    }
  });
}
