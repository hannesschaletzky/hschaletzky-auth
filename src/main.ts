import { createAuth } from './auth/better-auth.js';
import { loadAppConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { createApp } from './http/app.js';
import { log } from './log.js';

const config = loadAppConfig();
const database = createDatabase(config.databaseUrl);
const auth = createAuth({ db: database.db, config });
const app = createApp({ db: database.db, auth });

const server = app.listen(config.port, () => {
  log.info('server listening', { port: config.port, resources: config.resources.length });
});

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  server.close(() => {
    void database.close().then(() => process.exit(0));
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
