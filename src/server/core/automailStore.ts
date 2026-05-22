// SPDX-License-Identifier: GPL-3.0-only
// Redis-backed store: settings JSON, per-conversation state, tone prompt,
// and the cross-sub subscriber set used by the scheduled scan tick.

import { redis } from '@devvit/web/server';
import {
  AUTOMAIL_DEFAULT_SETTINGS,
  AUTOMAIL_SCAN_STATES,
  GENERATED_SIGNATURE_DEFAULT,
  type RemovedPostSample,
  MAX_REPLIES_MAX,
  MAX_REPLIES_MIN,
  PM_THRESHOLDS,
  type AutoMailConvoState,
  type AutoMailScanState,
  type AutoMailSettings,
  type PmThreshold,
  type SeverityResult,
  type SubredditPolicyContext,
} from '../../shared/automail';
import { k } from '../../shared/redisKeys';
import type { ResponderConversationTurn } from '../ai-public/genaiClient';

export type DetailedConvoReportSnapshot = {
  version: 1;
  concernSummary: string;
  severityLevel: number | null;
  categories: string[];
  claims: string[];
  evidenceKinds: string[];
  imageCount: number;
  commentCount: number;
  choices: string[];
};

export const CONVO_STATE_TTL_SEC = 60 * 24 * 60 * 60; // 60 days
const SEEN_MESSAGE_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const SCAN_LOCK_TTL_SEC = 120;
const PREFLIGHT_POLICY_TTL_SEC = 30 * 60;
const PREFLIGHT_REMOVED_TTL_SEC = 10 * 60;
const USER_CONVO_HISTORY_MAX_TURNS = 24;

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function sanitizeSettings(raw: unknown): AutoMailSettings {
  const s = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const respondRaw = Array.isArray(s['respondToStates']) ? s['respondToStates'] : [];
  const respondToStates: AutoMailScanState[] = [];
  for (const v of respondRaw) {
    if (typeof v === 'string' && (AUTOMAIL_SCAN_STATES as readonly string[]).includes(v)) {
      const cast = v as AutoMailScanState;
      if (!respondToStates.includes(cast)) respondToStates.push(cast);
    }
  }
  const thresholdNum = Number(s['pmModsThreshold']);
  const pmModsThreshold: PmThreshold =
    Number.isFinite(thresholdNum) && (PM_THRESHOLDS as readonly number[]).includes(Math.floor(thresholdNum))
      ? (Math.floor(thresholdNum) as PmThreshold)
      : AUTOMAIL_DEFAULT_SETTINGS.pmModsThreshold;
  const signatureRaw = typeof s['generatedSignature'] === 'string' ? s['generatedSignature'] : '';
  const generatedSignature = signatureRaw
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
    .trim()
    .slice(0, 140);
  return {
    enabled: Boolean(s['enabled']),
    respondToStates,
    tonePromptVersion: clampInt(s['tonePromptVersion'], 0, 1_000_000, 0),
    staleHours: clampInt(s['staleHours'], 1, 24 * 14, AUTOMAIL_DEFAULT_SETTINGS.staleHours),
    autoResolveAfterHours: clampInt(
      s['autoResolveAfterHours'], 1, 24 * 30, AUTOMAIL_DEFAULT_SETTINGS.autoResolveAfterHours,
    ),
    maxReplies: clampInt(
      s['maxReplies'],
      MAX_REPLIES_MIN,
      MAX_REPLIES_MAX,
      AUTOMAIL_DEFAULT_SETTINGS.maxReplies,
    ),
    pmModsThreshold,
    transcriptEnabled: Boolean(s['transcriptEnabled']),
    generatedSignature: generatedSignature.length > 0 ? generatedSignature : GENERATED_SIGNATURE_DEFAULT,
    lastScanAt: clampInt(s['lastScanAt'], 0, Number.MAX_SAFE_INTEGER, 0),
    updatedAt: clampInt(s['updatedAt'], 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

export async function getSettings(sub: string): Promise<AutoMailSettings> {
  try {
    const raw = await redis.get(k.settings(sub));
    if (!raw) return { ...AUTOMAIL_DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...AUTOMAIL_DEFAULT_SETTINGS };
  }
}

export async function saveSettings(sub: string, next: AutoMailSettings): Promise<AutoMailSettings> {
  const sanitized = sanitizeSettings({ ...next, updatedAt: Date.now() });
  await redis.set(k.settings(sub), JSON.stringify(sanitized));
  return sanitized;
}

export async function getTonePrompt(sub: string): Promise<string | null> {
  try {
    const raw = await redis.get(k.tonePrompt(sub));
    return raw && raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export async function saveTonePrompt(sub: string, text: string): Promise<void> {
  await redis.set(k.tonePrompt(sub), text);
}

export async function invalidateRulePolicyCaches(
  sub: string,
  opts?: { includeTonePrompt?: boolean },
): Promise<{ rules: boolean; policy: boolean; tone: boolean }> {
  let rules = false;
  let policy = false;
  let tone = false;
  try {
    await redis.del(k.rulesCache(sub));
    rules = true;
  } catch { /* best-effort */ }
  try {
    await redis.del(k.policyContextCache(sub));
    policy = true;
  } catch { /* best-effort */ }
  if (opts?.includeTonePrompt === true) {
    try {
      await redis.del(k.tonePrompt(sub));
      tone = true;
    } catch { /* best-effort */ }
  }
  return { rules, policy, tone };
}

export async function getConvoState(
  sub: string,
  conversationId: string,
): Promise<AutoMailConvoState | null> {
  try {
    const raw = await redis.get(k.convoState(sub, conversationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutoMailConvoState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function setConvoState(sub: string, state: AutoMailConvoState): Promise<void> {
  const next: AutoMailConvoState = { ...state, updatedAt: Date.now() };
  await redis.set(k.convoState(sub, state.conversationId), JSON.stringify(next), {
    expiration: new Date(Date.now() + CONVO_STATE_TTL_SEC * 1000),
  });
}

function sanitizeHistoryTurns(turns: ResponderConversationTurn[]): ResponderConversationTurn[] {
  const cleaned: ResponderConversationTurn[] = [];
  for (const t of turns) {
    if (!t || typeof t !== 'object') continue;
    const role = t.role === 'user' || t.role === 'mod' || t.role === 'app' ? t.role : 'user';
    const authorName = typeof t.authorName === 'string' ? t.authorName.slice(0, 80) : 'unknown';
    const body = typeof t.body === 'string' ? t.body.replace(/\s+/g, ' ').slice(0, 1500) : '';
    const createdAtIso = typeof t.createdAtIso === 'string'
      ? t.createdAtIso
      : new Date().toISOString();
    cleaned.push({
      role,
      authorIsMod: Boolean(t.authorIsMod),
      authorIsApp: Boolean(t.authorIsApp),
      authorName,
      body,
      createdAtIso,
    });
  }
  return cleaned.slice(-USER_CONVO_HISTORY_MAX_TURNS);
}

export async function getUserConversationHistory(
  sub: string,
  user: string,
): Promise<ResponderConversationTurn[]> {
  try {
    const raw = await redis.get(k.userConvoHistory(sub, user));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return sanitizeHistoryTurns(parsed as ResponderConversationTurn[]);
  } catch {
    return [];
  }
}

export async function setUserConversationHistory(
  sub: string,
  user: string,
  turns: ResponderConversationTurn[],
): Promise<void> {
  try {
    const cleaned = sanitizeHistoryTurns(turns);
    await redis.set(k.userConvoHistory(sub, user), JSON.stringify(cleaned), {
      expiration: new Date(Date.now() + CONVO_STATE_TTL_SEC * 1000),
    });
  } catch { /* best-effort */ }
}

export async function claimSeenMessage(sub: string, messageId: string): Promise<boolean> {
  try {
    const res = await redis.set(k.seenMessage(sub, messageId), '1', {
      nx: true,
      expiration: new Date(Date.now() + SEEN_MESSAGE_TTL_SEC * 1000),
    });
    return typeof res === 'string' && res.toUpperCase() === 'OK';
  } catch {
    return false;
  }
}

export async function acquireScanLock(sub: string): Promise<boolean> {
  try {
    const res = await redis.set(k.scanLock(sub), String(Date.now()), {
      nx: true,
      expiration: new Date(Date.now() + SCAN_LOCK_TTL_SEC * 1000),
    });
    return typeof res === 'string' && res.toUpperCase() === 'OK';
  } catch {
    return false;
  }
}

export async function releaseScanLock(sub: string): Promise<void> {
  try { await redis.del(k.scanLock(sub)); } catch { /* best-effort */ }
}

export async function addSubscriber(sub: string): Promise<void> {
  try { await redis.zAdd(k.subscribers(), { score: Date.now(), member: sub.toLowerCase() }); }
  catch (err) { console.warn('[amu/store] addSubscriber failed:', err); }
}

export async function removeSubscriber(sub: string): Promise<void> {
  try { await redis.zRem(k.subscribers(), [sub.toLowerCase()]); }
  catch (err) { console.warn('[amu/store] removeSubscriber failed:', err); }
}

export async function listSubscribers(): Promise<string[]> {
  try {
    const rows = await redis.zRange(k.subscribers(), 0, -1, { by: 'rank' });
    return rows
      .map((r) => (typeof r === 'string' ? r : (r as { member?: string }).member ?? ''))
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

export async function incrReplyCount(sub: string, conversationId: string): Promise<number> {
  try {
    const next = await redis.incrBy(k.replyCount(sub, conversationId), 1);
    try {
      await redis.expire(k.replyCount(sub, conversationId), CONVO_STATE_TTL_SEC);
    } catch { /* best-effort */ }
    return Number.isFinite(next) ? Number(next) : 0;
  } catch {
    return 0;
  }
}

export async function getReplyCount(sub: string, conversationId: string): Promise<number> {
  try {
    const raw = await redis.get(k.replyCount(sub, conversationId));
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export async function claimFinalHandoff(sub: string, conversationId: string): Promise<boolean> {
  try {
    const res = await redis.set(k.replyCountFinal(sub, conversationId), '1', {
      nx: true,
      expiration: new Date(Date.now() + CONVO_STATE_TTL_SEC * 1000),
    });
    return typeof res === 'string' && res.toUpperCase() === 'OK';
  } catch {
    return false;
  }
}

/** @deprecated - transcript is now posted as an internal modmail reply. */
export async function getTranscript(sub: string, conversationId: string): Promise<string | null> {
  try {
    const raw = await redis.get(k.transcript(sub, conversationId));
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** @deprecated - transcript is now posted as an internal modmail reply. */
export async function setTranscript(
  sub: string,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    await redis.set(k.transcript(sub, conversationId), text, {
      expiration: new Date(Date.now() + CONVO_STATE_TTL_SEC * 1000),
    });
  } catch { /* best-effort */ }
}

export async function claimTranscriptSent(sub: string, conversationId: string): Promise<boolean> {
  try {
    const res = await redis.set(k.transcriptSent(sub, conversationId), '1', {
      nx: true,
      expiration: new Date(Date.now() + CONVO_STATE_TTL_SEC * 1000),
    });
    return typeof res === 'string' && res.toUpperCase() === 'OK';
  } catch {
    return false;
  }
}

export async function releaseTranscriptSent(sub: string, conversationId: string): Promise<void> {
  try {
    await redis.del(k.transcriptSent(sub, conversationId));
  } catch { /* best-effort */ }
}

export async function getCachedSeverity(
  sub: string,
  messageId: string,
): Promise<SeverityResult | null> {
  try {
    const raw = await redis.get(k.severity(sub, messageId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SeverityResult;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function setCachedSeverity(
  sub: string,
  messageId: string,
  result: SeverityResult,
): Promise<void> {
  try {
    await redis.set(k.severity(sub, messageId), JSON.stringify(result), {
      expiration: new Date(Date.now() + CONVO_STATE_TTL_SEC * 1000),
    });
  } catch { /* best-effort */ }
}

export async function claimPmFingerprint(
  sub: string,
  conversationId: string,
  fingerprint: string,
): Promise<boolean> {
  try {
    const res = await redis.set(k.pmSent(sub, conversationId, fingerprint), '1', {
      nx: true,
      expiration: new Date(Date.now() + CONVO_STATE_TTL_SEC * 1000),
    });
    return typeof res === 'string' && res.toUpperCase() === 'OK';
  } catch {
    return false;
  }
}

export async function releasePmFingerprint(
  sub: string,
  conversationId: string,
  fingerprint: string,
): Promise<void> {
  try {
    await redis.del(k.pmSent(sub, conversationId, fingerprint));
  } catch { /* best-effort */ }
}

export async function claimDetailedReportSent(
  sub: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const res = await redis.set(k.detailedReportSent(sub, conversationId), '1', {
      nx: true,
      expiration: new Date(Date.now() + CONVO_STATE_TTL_SEC * 1000),
    });
    return typeof res === 'string' && res.toUpperCase() === 'OK';
  } catch {
    return false;
  }
}

export async function releaseDetailedReportSent(
  sub: string,
  conversationId: string,
): Promise<void> {
  try {
    await redis.del(k.detailedReportSent(sub, conversationId));
  } catch { /* best-effort */ }
}

function sanitizeDetailedReportSnapshot(raw: unknown): DetailedConvoReportSnapshot | null {
  const value = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : null;
  if (!value) return null;
  const categories = Array.isArray(value['categories'])
    ? value['categories'].filter((entry): entry is string => typeof entry === 'string').slice(0, 16)
    : [];
  const claims = Array.isArray(value['claims'])
    ? value['claims'].filter((entry): entry is string => typeof entry === 'string').slice(0, 16)
    : [];
  const evidenceKinds = Array.isArray(value['evidenceKinds'])
    ? value['evidenceKinds'].filter((entry): entry is string => typeof entry === 'string').slice(0, 32)
    : [];
  const choices = Array.isArray(value['choices'])
    ? value['choices'].filter((entry): entry is string => typeof entry === 'string').slice(0, 16)
    : [];
  const severityRaw = value['severityLevel'];
  const severityLevel = typeof severityRaw === 'number' && Number.isFinite(severityRaw)
    ? severityRaw
    : null;
  return {
    version: 1,
    concernSummary: typeof value['concernSummary'] === 'string' ? value['concernSummary'].slice(0, 400) : '',
    severityLevel,
    categories,
    claims,
    evidenceKinds,
    imageCount: typeof value['imageCount'] === 'number' && Number.isFinite(value['imageCount'])
      ? Math.max(0, Math.floor(value['imageCount']))
      : 0,
    commentCount: typeof value['commentCount'] === 'number' && Number.isFinite(value['commentCount'])
      ? Math.max(0, Math.floor(value['commentCount']))
      : 0,
    choices,
  };
}

export async function getDetailedReportSnapshot(
  sub: string,
  conversationId: string,
): Promise<DetailedConvoReportSnapshot | null> {
  try {
    const raw = await redis.get(k.detailedReportSnapshot(sub, conversationId));
    if (!raw) return null;
    return sanitizeDetailedReportSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function setDetailedReportSnapshot(
  sub: string,
  conversationId: string,
  snapshot: DetailedConvoReportSnapshot,
): Promise<void> {
  try {
    const cleaned = sanitizeDetailedReportSnapshot(snapshot);
    if (!cleaned) return;
    await redis.set(k.detailedReportSnapshot(sub, conversationId), JSON.stringify(cleaned), {
      expiration: new Date(Date.now() + CONVO_STATE_TTL_SEC * 1000),
    });
  } catch { /* best-effort */ }
}

export async function claimDetailedReportRevision(
  sub: string,
  conversationId: string,
  fingerprint: string,
): Promise<boolean> {
  try {
    const res = await redis.set(k.detailedReportRevision(sub, conversationId, fingerprint), '1', {
      nx: true,
      expiration: new Date(Date.now() + CONVO_STATE_TTL_SEC * 1000),
    });
    return typeof res === 'string' && res.toUpperCase() === 'OK';
  } catch {
    return false;
  }
}

export async function releaseDetailedReportRevision(
  sub: string,
  conversationId: string,
  fingerprint: string,
): Promise<void> {
  try {
    await redis.del(k.detailedReportRevision(sub, conversationId, fingerprint));
  } catch { /* best-effort */ }
}

export async function getCachedPolicyContext(sub: string): Promise<SubredditPolicyContext | null> {
  try {
    const raw = await redis.get(k.policyContextCache(sub));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SubredditPolicyContext;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function setCachedPolicyContext(sub: string, value: SubredditPolicyContext): Promise<void> {
  try {
    await redis.set(k.policyContextCache(sub), JSON.stringify(value), {
      expiration: new Date(Date.now() + PREFLIGHT_POLICY_TTL_SEC * 1000),
    });
  } catch { /* best-effort */ }
}

export async function getCachedRecentRemoved(
  sub: string,
  topicKey: string,
): Promise<RemovedPostSample[] | null> {
  try {
    const raw = await redis.get(k.recentRemovedCache(sub, topicKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RemovedPostSample[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function setCachedRecentRemoved(
  sub: string,
  topicKey: string,
  samples: RemovedPostSample[],
): Promise<void> {
  try {
    await redis.set(k.recentRemovedCache(sub, topicKey), JSON.stringify(samples), {
      expiration: new Date(Date.now() + PREFLIGHT_REMOVED_TTL_SEC * 1000),
    });
  } catch { /* best-effort */ }
}
