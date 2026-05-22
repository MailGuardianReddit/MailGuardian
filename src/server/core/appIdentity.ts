// SPDX-License-Identifier: GPL-3.0-only
// Cached lookup of the app account's username so the responder can tell
// "the AI replied" from "a human mod replied".

import { reddit, redis } from '@devvit/web/server';
import { k } from '../../shared/redisKeys';

const TTL_SECONDS = 300;
const MEM_TTL_MS = 5 * 60 * 1000;

let memo: { value: string; expiresAtMs: number } | null = null;

function canonical(value: string | null | undefined): string {
  if (!value) return '';
  return value.trim().toLowerCase().replace(/^@+/, '').replace(/^\/?u\//, '').trim();
}

export async function getAppUsernameCached(): Promise<string> {
  const now = Date.now();
  if (memo && memo.expiresAtMs > now) return memo.value;
  try {
    const cached = await redis.get(k.appUsername());
    if (typeof cached === 'string' && cached) {
      memo = { value: cached, expiresAtMs: now + MEM_TTL_MS };
      return cached;
    }
  } catch { /* fall through */ }
  try {
    const appUser = await reddit.getAppUser();
    const norm = canonical(appUser?.username ?? '');
    if (norm) {
      memo = { value: norm, expiresAtMs: now + MEM_TTL_MS };
      try {
        await redis.set(k.appUsername(), norm);
        await redis.expire(k.appUsername(), TTL_SECONDS);
      } catch { /* best-effort */ }
      return norm;
    }
  } catch { /* ignore */ }
  return '';
}
