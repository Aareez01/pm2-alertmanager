import { readFileSync, existsSync, watch, FSWatcher } from 'node:fs';
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
  try {
    let timer: NodeJS.Timeout | null = null;
    return watch(path, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const next = fromFile(path, env);
          log.info('configuration reloaded', { path });
          onChange(next);
        } catch (err) {
          log.error('config reload failed, keeping previous configuration', {
            path, error: (err as Error).message,
          });
        }
      }, 1000);
    });
  } catch (err) {
    log.warn('could not watch config file', { path, error: (err as Error).message });
    return null;
  }
}
