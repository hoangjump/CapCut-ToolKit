import { randomInt } from 'node:crypto';
import type { Profile, ProxyConfig, ProxyRotation } from './types.js';
import { defaultProxyRotation } from './types.js';
import type { ProxyStore, ProxyRecord } from './proxyStore.js';

/** What kicked off the resolve — controls whether a pool profile re-draws. */
export type ResolveTrigger = 'open' | 'manual' | 'failure';

export interface ResolveResult {
  /** Proxy to launch with, or undefined for a direct connection. */
  proxy?: ProxyConfig;
  /** ProxyStore record id backing `proxy` (pool mode only). */
  assignedProxyId?: string;
  /** Whether this differs from what the profile currently has persisted. */
  changed: boolean;
}

/** ProxyStore record → the ProxyConfig the browser launches with. Auth stays in
 *  its own fields so makeRelay can inject it into the upstream URL; `server`
 *  carries only scheme+host+port. */
export function recordToConfig(p: ProxyRecord): ProxyConfig {
  return {
    server: `${p.type}://${p.host}:${p.port}`,
    username: p.username,
    password: p.password,
  };
}

/** Candidates from the store matching the pool filter, optionally excluding one
 *  id (the currently-assigned proxy, so a rotation actually moves). */
function poolCandidates(store: ProxyStore, rotation: ProxyRotation, excludeId?: string): ProxyRecord[] {
  const filter = rotation.pool ?? {};
  const liveOnly = filter.liveOnly ?? true;
  const wantTags = filter.tags ?? [];
  let list = store.list();
  if (liveOnly) list = list.filter((p) => p.alive === true);
  if (wantTags.length) list = list.filter((p) => wantTags.every((t) => p.tags.includes(t)));
  const withoutExcluded = excludeId ? list.filter((p) => p.id !== excludeId) : list;
  // Only drop the excluded one if other candidates remain — otherwise re-picking
  // the same proxy beats refusing to open.
  return withoutExcluded.length ? withoutExcluded : list;
}

function pickRandom<T>(items: T[]): T {
  return items[randomInt(0, items.length)];
}

/**
 * Decides which proxy a profile should launch with. Pure decision — persisting
 * the choice onto the profile is the caller's job (BrowserManager) when
 * `changed` is true.
 *
 * - static / gateway: return the pinned `profile.proxy` untouched.
 * - pool: reuse the assigned draw unless a rotation is warranted, else draw a
 *   fresh random candidate. Throws when the filter yields no candidate so the
 *   caller refuses to open rather than leaking the real IP via a direct connect.
 */
export function resolveProxy(
  profile: Profile,
  store: ProxyStore | undefined,
  opts: { trigger: ResolveTrigger },
): ResolveResult {
  const rotation = profile.proxyRotation ?? defaultProxyRotation();

  if (rotation.mode !== 'pool') {
    // static / gateway: proxy is whatever is pinned on the profile.
    return { proxy: profile.proxy, assignedProxyId: profile.assignedProxyId, changed: false };
  }

  if (!store) throw new Error('Pool proxy cần ProxyStore nhưng BrowserManager không có');

  const needRotate =
    opts.trigger !== 'open' || rotation.rotateOnOpen === true || !profile.assignedProxyId;

  // Reuse the assigned draw when no rotation is warranted and it still exists.
  if (!needRotate && profile.assignedProxyId && store.get(profile.assignedProxyId)) {
    return { proxy: profile.proxy, assignedProxyId: profile.assignedProxyId, changed: false };
  }

  const candidates = poolCandidates(store, rotation, profile.assignedProxyId);
  if (!candidates.length) {
    throw new Error('Không có proxy Live nào trong pool khớp bộ lọc');
  }

  const chosen = pickRandom(candidates);
  return {
    proxy: recordToConfig(chosen),
    assignedProxyId: chosen.id,
    changed: chosen.id !== profile.assignedProxyId,
  };
}
