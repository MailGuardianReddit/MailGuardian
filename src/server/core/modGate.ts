// SPDX-License-Identifier: GPL-3.0-only
// Minimal mod check for Mail Guardian. Looks up the current
// subreddit's moderators and verifies the current user is one of them.
// Fail-closed on any error.

import { context, reddit, redis } from '@devvit/web/server';

const MOD_CACHE_TTL_SECONDS = 60;
const modsKey = (sub: string) => `amu:mods:${sub.toLowerCase()}`;

async function getCachedModerators(sub: string): Promise<Set<string>> {
  const key = modsKey(sub);
  try {
    const cached = await redis.hGetAll(key);
    const names = Object.keys(cached ?? {});
    if (names.length > 0) return new Set(names);
  } catch { /* fall through */ }

  const names = new Set<string>();
  try {
    const list = await reddit.getModerators({ subredditName: sub });
    const members = await list.all();
    for (const m of members) {
      if (m.username) names.add(m.username.toLowerCase());
    }
  } catch (err) {
    console.warn('[amu/modGate] getModerators failed:', err);
    return names;
  }
  try {
    await redis.del(key);
    if (names.size > 0) {
      const entries: Record<string, string> = {};
      for (const n of names) entries[n] = '1';
      await redis.hSet(key, entries);
    }
    await redis.expire(key, MOD_CACHE_TTL_SECONDS);
  } catch { /* best-effort */ }
  return names;
}

export async function isCurrentUserMod(): Promise<boolean> {
  const sub = context.subredditName;
  const username = context.username;
  if (!sub || !username) return false;
  try {
    const mods = await getCachedModerators(sub);
    return mods.has(username.toLowerCase());
  } catch (err) {
    console.warn('[amu/modGate] isCurrentUserMod failed:', err);
    return false;
  }
}
