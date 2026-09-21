import { isIP } from 'node:net';

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 3838;

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const LEGACY_NUMERIC_ADDRESS = /^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*$/i;
const DECIMAL_PORT = /^[1-9][0-9]*$/;
function isWildcardHost(host) {
  if (host === '0.0.0.0') return true;
  if (isIP(host) !== 6) return false;
  const lower = host.toLowerCase();
  return lower.replaceAll(':', '').replaceAll('0', '') === ''
    || lower === '::ffff:0.0.0.0'
    || lower === '::ffff:0:0';
}

export function resolveHttpHost(value) {
  const host = value?.trim() || DEFAULT_HTTP_HOST;
  const hostname = host.length <= 253
    && host.split('.').every(label => HOSTNAME_LABEL.test(label));
  if (!isIP(host) && (LEGACY_NUMERIC_ADDRESS.test(host) || !hostname)) {
    throw new Error(
      `KB_HOST must be an unbracketed IP address or hostname (got ${JSON.stringify(host)})`,
    );
  }
  return host;
}

export function resolveHttpPort(value) {
  const raw = String(value ?? '').trim() || String(DEFAULT_HTTP_PORT);
  const port = Number(raw);
  if (!DECIMAL_PORT.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`KB_PORT must be an integer from 1 to 65535 (got ${JSON.stringify(raw)})`);
  }
  return port;
}

export function resolveHttpBind(env = process.env) {
  return {
    host: resolveHttpHost(env.KB_HOST),
    port: resolveHttpPort(env.KB_PORT),
  };
}

export function listenHttpServer(app, { host, port }, onListening) {
  return app.listen(port, host, onListening);
}

export function formatHttpServerUrl({ host, port }) {
  const displayHost = host.includes(':') && !host.startsWith('[')
    ? `[${host}]`
    : host;
  return `http://${displayHost}:${port}`;
}

export function resolveHttpOrigin(bind, env = process.env) {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL.replace(/\/+$/, '');
  const host = isWildcardHost(bind.host) ? 'localhost' : bind.host;
  return formatHttpServerUrl({ ...bind, host });
}

export function resolveHttpTrustedOrigins(bind, env = process.env) {
  const origin = resolveHttpOrigin(bind, env);
  if (env.BETTER_AUTH_URL) return [origin];
  if (!['127.0.0.1', 'localhost', '::1'].includes(bind.host)) return [origin];
  return [...new Set([
    origin,
    formatHttpServerUrl({ ...bind, host: 'localhost' }),
    formatHttpServerUrl({ ...bind, host: '127.0.0.1' }),
  ])];
}
