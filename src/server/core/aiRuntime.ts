// SPDX-License-Identifier: GPL-3.0-only
// Bridges the per-mod key store into the @ai key rotator and exposes
// a single resolveAiKey(sub) for tone + responder.

import { redis } from '@devvit/web/server';
import type { AiKeySelectionResult } from '../../shared/aiTypes';
import { k } from '../../shared/redisKeys';
import { listKeyPool } from './aiConfigStore';
import { pickAiKey } from '@ai';

export async function resolveAiKey(sub: string): Promise<AiKeySelectionResult> {
  const pool = await listKeyPool(sub);
  if (pool.length === 0) return { ok: false, error: 'NO_KEYS_AVAILABLE' };
  return pickAiKey({
    redis: {
      get: async (key) => (await redis.get(key)) ?? null,
      set: async (key, value) => { await redis.set(key, value); },
    },
    rotationKey: k.aiKeyRotation(sub),
    pool,
  });
}

export async function isAiEnabledForSubreddit(sub: string): Promise<boolean> {
  const pool = await listKeyPool(sub);
  return pool.some((e) => e.enabled && e.apiKey.length > 0);
}
