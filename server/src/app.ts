import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { MongoServerError } from 'mongodb';
import { closeAllClients, poolStats, redactUri } from './db/connection.js';
import { HttpError } from './lib/http.js';
import { mcpRoutes } from './mcp/mcpServer.js';
import { isForceReadOnly } from './middleware/readOnly.js';
import { queryRoutes } from './routes/query.js';
import { recipeRoutes } from './routes/recipe.js';
import { shellRoutes } from './routes/shell.js';
import { transferRoutes } from './routes/transfer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLIENT_DIST = path.resolve(here, '../../client/dist');

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  clientDist?: string;
}

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL ?? 'info',
      // Defence in depth: connection strings must never reach logs.
      redact: { paths: ['req.headers["x-mongo-uri"]', 'req.headers["x-litemongo-config"]', 'req.headers.authorization'], censor: '[redacted]' },
    },
    bodyLimit: 32 * 1024 * 1024, // EJSON transfer bundles
    disableRequestLogging: false,
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: 'REQUEST_ERROR', message: error.message });
    }
    if (error instanceof MongoServerError) {
      const status = error.code === 13 || error.code === 18 ? 403 : 400; // Unauthorized / AuthFailed
      return reply
        .code(status)
        .send({ error: 'MONGO_ERROR', code: error.code ?? null, message: redactUri(error.message) });
    }
    const err = error as { statusCode?: number; message?: string };
    if (typeof err.statusCode === 'number' && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'REQUEST_ERROR', message: err.message ?? 'Bad request' });
    }
    request.log.error({ err: redactUri(err.message ?? String(error)) }, 'unhandled error');
    return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  app.get('/api/health', async () => ({
    ok: true,
    forceReadOnly: isForceReadOnly(),
    pool: poolStats(),
  }));

  await app.register(queryRoutes);
  await app.register(recipeRoutes);
  await app.register(transferRoutes);
  await app.register(shellRoutes);
  await app.register(mcpRoutes);

  // Serve the compiled React app from the same origin/port when it exists.
  const clientDist = options.clientDist ?? process.env.CLIENT_DIST ?? DEFAULT_CLIENT_DIST;
  if (existsSync(path.join(clientDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: clientDist,
      // Resolve files per request (not a route table frozen at boot), so a rebuilt
      // client is served without restarting; misses fall through to the handler below.
      wildcard: true,
      setHeaders: (res, filePath) => {
        // Vite assets are content-hashed; sw.js / manifest / index.html must revalidate.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('cache-control', 'public, max-age=31536000, immutable');
        } else {
          res.header('cache-control', 'no-cache');
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api') && !request.url.startsWith('/mcp')) {
        return reply.sendFile('index.html'); // SPA fallback
      }
      return reply.code(404).send({ error: 'NOT_FOUND', message: `${request.method} ${request.url} not found` });
    });
  }

  app.addHook('onClose', async () => {
    await closeAllClients();
  });

  return app;
}
