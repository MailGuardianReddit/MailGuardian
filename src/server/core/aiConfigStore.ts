// SPDX-License-Identifier: GPL-3.0-only
// Per-mod Gemini API key store + listing for the round-robin pool.
// Keys are stored under amu:aikey:<sub>:<owner>. Owner index is a hash
// amu:aikey-owners:<sub> mapping owner -> updatedAt (ms epoch).

import { redis } from '@devvit/web/server';
import { k } from '../../shared/redisKeys';
import type { AiKeyPoolEntry } from '../../shared/aiTypes';

type StoredEntry = {
  apiKey: string;
  enabled: boolean;
  updatedAt: number;
};

export type ModKeySlotSummary = {
  slot: number;
  hasKey: boolean;
  enabled: boolean;
  updatedAt: number;
};

export const MOD_KEY_SLOTS = 3;
const SLOT_OWNER_SEP = '__slot__';

function normalizeUser(user: string): string {
  return user.toLowerCase();
}

function slotOwner(user: string, slot: number): string {
  return `${normalizeUser(user)}${SLOT_OWNER_SEP}${slot}`;
}

function parseSlotOwner(owner: string): { baseUser: string; slot: number } | null {
  const m = owner.match(/^(.*)__slot__(\d+)$/);
  if (!m) return null;
  const baseUser = (m[1] ?? '').trim();
  const slot = Number.parseInt(m[2] ?? '0', 10);
  if (!baseUser || !Number.isFinite(slot) || slot < 1 || slot > MOD_KEY_SLOTS) return null;
  return { baseUser, slot };
}

function clampSlot(slot: number): number {
  const n = Number.isFinite(slot) ? Math.floor(slot) : 1;
  return Math.max(1, Math.min(MOD_KEY_SLOTS, n));
}

function safeParse(raw: string | null | undefined): StoredEntry | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredEntry>;
    if (!v || typeof v.apiKey !== 'string') return null;
    return {
      apiKey: v.apiKey,
      enabled: Boolean(v.enabled ?? true),
      updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export async function saveModKey(sub: string, user: string, apiKey: string): Promise<void> {
  await saveModKeySlot(sub, user, 1, apiKey);
}

export async function saveModKeySlot(sub: string, user: string, slot: number, apiKey: string): Promise<void> {
  const clamped = clampSlot(slot);
  const owner = clamped === 1 ? normalizeUser(user) : slotOwner(user, clamped);
  const entry: StoredEntry = { apiKey, enabled: true, updatedAt: Date.now() };
  await redis.set(k.aiKey(sub, owner), JSON.stringify(entry));
  await redis.hSet(k.aiKeyOwners(sub), { [owner]: String(entry.updatedAt) });
}

export async function clearModKey(sub: string, user: string): Promise<void> {
  await clearModKeySlot(sub, user, 1);
}

export async function clearModKeySlot(sub: string, user: string, slot: number): Promise<void> {
  const clamped = clampSlot(slot);
  const owner = clamped === 1 ? normalizeUser(user) : slotOwner(user, clamped);
  try { await redis.del(k.aiKey(sub, owner)); } catch { /* ignore */ }
  try { await redis.hDel(k.aiKeyOwners(sub), [owner]); } catch { /* ignore */ }
}

export async function getModKey(sub: string, user: string): Promise<StoredEntry | null> {
  return safeParse(await redis.get(k.aiKey(sub, normalizeUser(user))));
}

export async function setModKeyEnabled(sub: string, user: string, enabled: boolean): Promise<void> {
  const cur = await getModKey(sub, user);
  if (!cur) return;
  await redis.set(k.aiKey(sub, normalizeUser(user)), JSON.stringify({ ...cur, enabled, updatedAt: Date.now() }));
}

export async function listModKeySlots(sub: string, user: string): Promise<ModKeySlotSummary[]> {
  const out: ModKeySlotSummary[] = [];
  for (let slot = 1; slot <= MOD_KEY_SLOTS; slot += 1) {
    const owner = slot === 1 ? normalizeUser(user) : slotOwner(user, slot);
    const entry = safeParse(await redis.get(k.aiKey(sub, owner)));
    out.push({
      slot,
      hasKey: Boolean(entry && entry.apiKey.trim().length > 0),
      enabled: entry?.enabled ?? false,
      updatedAt: entry?.updatedAt ?? 0,
    });
  }
  return out;
}

export async function listKeyPool(sub: string): Promise<AiKeyPoolEntry[]> {
  let usernames: string[] = [];
  try {
    const map = await redis.hGetAll(k.aiKeyOwners(sub));
    usernames = Object.keys(map ?? {});
  } catch {
    usernames = [];
  }
  if (usernames.length === 0) return [];
  const pool: AiKeyPoolEntry[] = [];
  for (const owner of usernames) {
    const entry = safeParse(await redis.get(k.aiKey(sub, owner)));
    if (!entry) continue;
    const parsed = parseSlotOwner(owner);
    const username = parsed ? `${parsed.baseUser}#${parsed.slot}` : owner;
    pool.push({ username, apiKey: entry.apiKey, enabled: entry.enabled });
  }
  return pool;
}
