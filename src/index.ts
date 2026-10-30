/**
 * pm2-alertmanager entry point.
 *
 * Runs as an ordinary PM2-managed process (`pm2 install pm2-alertmanager`). PM2 injects
 * module configuration as environment variables and restarts the module when `pm2 set`
 * changes one - which is precisely why persisted state and bus reconciliation matter:
 * a routine config change takes this process down and back up mid-incident.
 */
import { FSWatcher } from 'node:fs';
import { loadConfig, watchConfigFile } from './config/load';
import { ConfigError } from './config/schema';
import { Pm2Client } from './pm2/client';
import { Engine } from './core/engine';
import { registerMetrics } from './core/metrics';
import { log, setLogLevel } from './log';

async function main(): Promise<void> {
  const loaded = loadConfig();
  setLogLevel(loaded.config.logLevel);
  registerMetrics();

  const client = new Pm2Client();
  await client.connect();

  const engine = new Engine(client, loaded.config);
  await engine.start();

  let watcher: FSWatcher | null = null;
  if (loaded.source === 'file' && loaded.path) {
    watcher = watchConfigFile(loaded.path, process.env, (next) => {
      setLogLevel(next.config.logLevel);
      engine.updateConfig(next.config);
    });
  }

  // `pm2 trigger pm2-alertmanager test-alert`
  process.on('message', (packet: unknown) => {
    const topic = (packet as { topic?: string })?.topic;
    if (topic === 'test-alert') {
      void engine.testAlert().catch((err) =>
        log.error('test alert failed', { error: (err as Error).message }));
    }
  });

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    engine.stop();
    watcher?.close();
    client.disconnect();
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// An alerting tool that dies silently is the worst possible failure mode: you only find
// out when something breaks and nobody is told. Nothing may escape.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { error: err.message, stack: err.stack });
});

main().catch((err) => {
  if (err instanceof ConfigError) {
    log.error('startup aborted: invalid configuration', { issues: err.issues });
  } else {
    log.error('startup failed', { error: (err as Error).message });
  }
  process.exit(1);
});
