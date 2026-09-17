/* Load .env before anything reads process.env. db.ts picks DB_PATH at import time and ES modules
   evaluate in import order, so this has to be the first import in collector/index.ts. */

try {
  process.loadEnvFile(".env");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
