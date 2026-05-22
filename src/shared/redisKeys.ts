// SPDX-License-Identifier: GPL-3.0-only
// Redis key namespace for Mail Guardian. Prefix is `amu:` (NOT `px:`).
// All keys are scoped per-subreddit. Per-mod state nests the mod username.

export const k = {
  // Settings JSON for one subreddit.
  settings: (sub: string) => `amu:settings:${sub.toLowerCase()}`,
  // Cached AI-generated voice/tone prompt.
  tonePrompt: (sub: string) => `amu:tone:${sub.toLowerCase()}`,
  // Per-conversation tracking JSON; TTL ~60d.
  convoState: (sub: string, conversationId: string) =>
    `amu:convo:${sub.toLowerCase()}:${conversationId}`,
  // Per-user modmail conversation history used for cross-convo AI context.
  userConvoHistory: (sub: string, user: string) =>
    `amu:user-convo:${sub.toLowerCase()}:${user.toLowerCase()}`,
  // SETNX lock so two scans don't overlap.
  scanLock: (sub: string) => `amu:scan-lock:${sub.toLowerCase()}`,
  // Idempotency guard so the same inbound messageId is processed once.
  seenMessage: (sub: string, messageId: string) =>
    `amu:seen:${sub.toLowerCase()}:${messageId}`,
  // ZSET (score=enabledAt, member=sub) of subs with the responder enabled.
  subscribers: () => `amu:subs`,

  // Per-mod Gemini key: STRING JSON { apiKey, enabled, updatedAt }.
  aiKey: (sub: string, user: string) =>
    `amu:aikey:${sub.toLowerCase()}:${user.toLowerCase()}`,
  // HASH username -> updatedAt of mods who have saved a key for this sub.
  aiKeyOwners: (sub: string) => `amu:aikey-owners:${sub.toLowerCase()}`,
  // Round-robin rotation index for the key pool.
  aiKeyRotation: (sub: string) => `amu:aikey-rot:${sub.toLowerCase()}`,

  // Cached app username for "is this message from me?" checks.
  appUsername: () => `amu:app:username`,
  // Cached subreddit rules text (per sub).
  rulesCache: (sub: string) => `amu:rules:${sub.toLowerCase()}`,
  // Cached merged policy context (rules + wiki + automod summaries).
  policyContextCache: (sub: string) => `amu:policy:${sub.toLowerCase()}`,
  // Cached removed-post snapshots keyed by topic fingerprint.
  recentRemovedCache: (sub: string, topicKey: string) =>
    `amu:removed:${sub.toLowerCase()}:${topicKey}`,

  // Mod-only translated transcript blob, JSON. TTL = CONVO_STATE_TTL_SEC.
  transcript: (sub: string, conversationId: string) =>
    `amu:transcript:${sub.toLowerCase()}:${conversationId}`,
  // NX flag: transcript internal note already posted for this convo.
  transcriptSent: (sub: string, conversationId: string) =>
    `amu:transcript:sent:${sub.toLowerCase()}:${conversationId}`,
  // INCR counter of AI replies sent in this convo.
  replyCount: (sub: string, conversationId: string) =>
    `amu:replycount:${sub.toLowerCase()}:${conversationId}`,
  // NX flag: final handoff message has been sent for this convo.
  replyCountFinal: (sub: string, conversationId: string) =>
    `amu:replycount:final:${sub.toLowerCase()}:${conversationId}`,
  // Cached SeverityResult per inbound user message id.
  severity: (sub: string, messageId: string) =>
    `amu:severity:${sub.toLowerCase()}:${messageId}`,
  // NX fingerprint of mod-PM already delivered for this convo+severity.
  pmSent: (sub: string, conversationId: string, fingerprint: string) =>
    `amu:pm:sent:${sub.toLowerCase()}:${conversationId}:${fingerprint}`,
  // NX flag: detailed internal report note already posted for this convo.
  detailedReportSent: (sub: string, conversationId: string) =>
    `amu:detail-report:sent:${sub.toLowerCase()}:${conversationId}`,
  // Last normalized detailed-report snapshot for warranted superseding updates.
  detailedReportSnapshot: (sub: string, conversationId: string) =>
    `amu:detail-report:snapshot:${sub.toLowerCase()}:${conversationId}`,
  // NX fingerprint for one posted detailed-report revision snapshot.
  detailedReportRevision: (sub: string, conversationId: string, fingerprint: string) =>
    `amu:detail-report:rev:${sub.toLowerCase()}:${conversationId}:${fingerprint}`,
} as const;
