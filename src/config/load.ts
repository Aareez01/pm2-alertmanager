import { readFileSync, existsSync, watch, FSWatcher, statSync } from 'node:fs';
import { extname } from 'node:path';
import * as yaml from 'js-yaml';
import { parseConfig, AlertmanagerConfig, ConfigError, redactConfigForDisplay } from './schema';
import { log } from '../log';

export interface LoadedConfig {
  config: AlertmanagerConfig;
  source: 'file' | 'module-config' | 'empty';
  path?: string;
}

function fromModuleConfig(env: NodeJS.ProcessEnv): LoadedConfig {
  const jsonOr = (raw: string | undefined, fallback: unknown, key: string): unknown => {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new ConfigError([`${key}: not valid JSON (${(e as Error).message})`]);
    }
  };

  const raw: Record<string, unknown> = {
    channels: jsonOr(env.channels, {}, 'channels'),
    routes: jsonOr(env.routes, [], 'routes'),
  };
  if (env.logLevel) raw.logLevel = env.logLevel;
  if (env.startupGraceSeconds) raw.startupGraceSeconds = Number(env.startupGraceSeconds);
  if (env.reconcileSeconds) raw.reconcileSeconds = Number(env.reconcileSeconds);
  if (env.stateFile) raw.stateFile = env.stateFile;

  const config = parseConfig(raw, env);
  const empty = Object.keys(config.channels).length === 0;
  return { config, source: empty ? 'empty' : 'module-config' };
}

function fromFile(path: string, env: NodeJS.ProcessEnv): LoadedConfig {
  if (!existsSync(path)) throw new ConfigError([`configFile: no such file: ${path}`]);
  const text = readFileSync(path, 'utf8');
  let raw: unknown;
  try {
    raw = extname(path).toLowerCase() === '.json' ? JSON.parse(text) : yaml.load(text);
  } catch (e) {
    throw new ConfigError([`configFile: could not parse ${path}: ${(e as Error).message}`]);
  }
  return { config: parseConfig(raw, env), source: 'file', path };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const file = (env.configFile ?? '').trim();
  const loaded = file ? fromFile(file, env) : fromModuleConfig(env);

  log.info('configuration loaded', {
    source: loaded.source,
    path: loaded.path,
    channels: Object.keys(loaded.config.channels),
    routes: loaded.config.routes.length,
  });
  log.debug('effective configuration', {
    config: redactConfigForDisplay(loaded.config),
  });

  if (loaded.source === 'empty') {
    log.warn(
      'no channels configured - pm2-alertmanager will detect conditions but send nothing. ' +
        'Configure with: pm2 set pm2-alertmanager:channels \'{"slack":{"type":"slack",' +
        '"webhookUrl":"${SLACK_WEBHOOK_URL}"}}\'',
    );
  }
  return loaded;
}

export function watchConfigFile(
  path: string,
  env: NodeJS.ProcessEnv,
  onChange: (c: LoadedConfig) => void,
): FSWatcher | null {
  // Deliberately NOT fs.watch. An editor, `sed -i`, or a config-management tool writes a
  // temp file and renames it over the target, which replaces the inode. fs.watch follows
  // the inode, so it fires for that rename and is then permanently dead - verified: zero
  // events for every edit after the first. Polling identity (inode + mtime + size) is
  // slower to notice and never stops working.
  let last: string | null = null;
  const probe = (): string | null => {
    try {
      const st = statSync(path);
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  };
  last = probe();

  const timer = setInterval(() => {
    const now = probe();
    if (now === null || now === last) return;
    last = now;
    try {
      const next = fromFile(path, env);
      log.info('configuration reloaded', { path });
      onChange(next);
    } catch (err) {
      log.error('config reload failed, keeping previous configuration', {
        path, error: (err as Error).message,
      });
    }
  }, 2000);
  timer.unref?.();

  // Shaped like an FSWatcher so callers need not care which mechanism is used.
  return { close: () => clearInterval(timer) } as unknown as FSWatcher;
}
