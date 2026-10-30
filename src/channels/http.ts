import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { DeliveryError } from './types';

/** Minimal JSON POST. No HTTP client dependency for one request shape. */
export function postJson(
  url: string,
  body: unknown,
  timeoutMs = 10_000,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new DeliveryError(`invalid url: ${url}`, false));
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');

    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { if (text.length < 8192) text += c; });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve({ status, body: text });
          // 4xx (except 429) will fail identically on retry - don't waste attempts.
          const retryable = status === 429 || status >= 500;
          reject(new DeliveryError(`HTTP ${status}: ${text.slice(0, 200)}`, retryable));
        });
      },
    );

    req.on('timeout', () => { req.destroy(); reject(new DeliveryError('timeout', true)); });
    req.on('error', (err) => reject(new DeliveryError(err.message, true)));
    req.end(payload);
  });
}
