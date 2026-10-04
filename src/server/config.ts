import { z } from 'zod';
import { isIP } from 'node:net';

const bool = z.enum(['true', 'false']).default('false').transform(v => v === 'true');
const envSchema = z.object({
  APP_ORIGIN: z.url().default('https://localhost:5173'),
  CALDAV_URL: z.url(), CALDAV_ALLOWED_PATHS: z.string().optional(), CALDAV_ALLOW_HTTP: bool,
  HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().min(1).max(65535).default(6742),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(168).default(8),
  MAX_SESSIONS: z.coerce.number().int().min(1).max(10000).default(100),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(15000),
  RATE_LIMIT_REQUESTS: z.coerce.number().int().min(1).max(100000).default(120),
  RATE_LIMIT_LOGINS: z.coerce.number().int().min(1).max(10000).default(10),
  TRUSTED_PROXIES: z.string().default(''),
});
export type Config = ReturnType<typeof loadConfig>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const upstream = new URL(parsed.CALDAV_URL);
  const origin = new URL(parsed.APP_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('APP_ORIGIN must be an HTTPS origin.');
  if (upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('CALDAV_URL must not include credentials, query, or fragment.');
  if (upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && parsed.CALDAV_ALLOW_HTTP)) throw new Error('CalDAV requires HTTPS. Set CALDAV_ALLOW_HTTP=true only for a trusted private network.');
  const paths = (parsed.CALDAV_ALLOWED_PATHS ?? upstream.pathname).split(',').map(p => p.trim());
  if (paths.some(p => !p.startsWith('/') || p.includes('\\') || p.includes('%') || p.split('/').some(s => s === '.' || s === '..'))) throw new Error('Allowed paths must be absolute, unencoded path prefixes.');
  const trustedProxies = parsed.TRUSTED_PROXIES.trim() ? parsed.TRUSTED_PROXIES.split(',').map(value => value.trim()) : [];
  for (const proxy of trustedProxies) {
    const [address, prefix, ...extra] = proxy.split('/');
    const family = isIP(address);
    if (!family || extra.length || (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new Error('TRUSTED_PROXIES must contain explicit IP addresses or CIDRs with a nonzero prefix.');
    }
  }
  return { ...parsed, APP_ORIGIN: origin.origin, CALDAV_URL: upstream.href, allowedPaths: paths, trustedProxies };
}
