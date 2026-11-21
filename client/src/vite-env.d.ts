/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Connection profile pre-filled on first start (defaults to the docker-compose MongoDB in `vite dev`). */
  readonly VITE_DEFAULT_MONGO_URI?: string;
}
