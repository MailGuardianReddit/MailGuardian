// SPDX-License-Identifier: GPL-3.0-only

import { reddit } from '@devvit/web/server';
import { callDraftPreflight } from '@ai';
import type {
  DraftPreflightContext,
  DraftPreflightInput,
  DraftPreflightResult,
  KarmaGateContext,
  RemovedPostSample,
  PostingRequirement,
  PostingRequirementKind,
  UserSignals,
  SubredditPolicyContext,
} from '../../shared/automail';
import {
  getCachedPolicyContext,
  getCachedRecentRemoved,
  setCachedPolicyContext,
  setCachedRecentRemoved,
} from './automailStore';
import { resolveAiKey } from './aiRuntime';
import { getRecentRemovedPostSamples } from './evidence';
import { looksLikeBypassRequest } from './draftExtraction';
import { getPolicyRequirementSummary, getSubredditPolicyContext } from './subredditRules';

const USER_LOOKUP_TIMEOUT_MS = 4000;

interface DraftPreflightUserApi {
  getUserByUsername(username: string): Promise<{
    createdAt: Date;
    linkKarma: number;
    commentKarma: number;
    hasVerifiedEmail?: boolean;
    isModerator?: boolean;
    getUserKarmaFromCurrentSubreddit(): Promise<{ fromComments?: number; fromPosts?: number }>;
    getComments(options: { sort?: 'hot' | 'new' | 'top' | 'controversial'; timeframe?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all'; limit?: number }): Promise<{ all(): Promise<Array<{ subredditName?: string; score?: number }>> }>;
    getPosts(options: { sort?: 'hot' | 'new' | 'top' | 'controversial'; timeframe?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all'; limit?: number }): Promise<{ all(): Promise<Array<{ subredditName?: string }>> }>;
  } | undefined>;
}

const userApi = (): DraftPreflightUserApi => reddit as unknown as DraftPreflightUserApi;

function asciiClean(s: string, maxLen: number): string {
  return (s ?? '')
    .replace(/[\u2014\u2013]/g, '--')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function topicKeyFromDraft(input: DraftPreflightInput): string {
  const seed = asciiClean(`${input.draftTitle} ${input.question}`, 100).toLowerCase();
  if (!seed) return 'generic';
  return seed.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'generic';
}

async function readPolicyContext(sub: string): Promise<SubredditPolicyContext> {
  const cached = await getCachedPolicyContext(sub);
  if (cached) return cached;
  const live = await getSubredditPolicyContext(sub);
  await setCachedPolicyContext(sub, live);
  return live;
}

async function readRemovedSamples(input: DraftPreflightInput): Promise<RemovedPostSample[]> {
  const topicKey = topicKeyFromDraft(input);
  const cached = await getCachedRecentRemoved(input.sub, topicKey);
  if (cached) return cached;
  const live = await getRecentRemovedPostSamples({
    sub: input.sub,
    topic: `${input.draftTitle} ${input.question}`,
    limit: 4,
  });
  await setCachedRecentRemoved(input.sub, topicKey, live);
  return live;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('timeout'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function requirementKindLabel(kind: PostingRequirement['kind']): string {
  switch (kind) {
    case 'karma': return 'karma';
    case 'comment_karma': return 'comment karma';
    case 'link_karma': return 'link karma';
    case 'account_age_days': return 'account age';
    case 'post_count': return 'post count';
    case 'comment_count': return 'comment count';
  }
}

function isKarmaRequirementKind(kind: PostingRequirementKind): boolean {
  return kind === 'karma' || kind === 'comment_karma' || kind === 'link_karma';
}

async function readUserSignals(username?: string): Promise<UserSignals | null> {
  if (!username) return null;
  try {
    const user = await withTimeout(userApi().getUserByUsername(username), USER_LOOKUP_TIMEOUT_MS);
    if (!user) return null;
    const [subKarma, comments, posts] = await Promise.all([
      withTimeout(user.getUserKarmaFromCurrentSubreddit().catch(() => ({ fromComments: undefined, fromPosts: undefined })), USER_LOOKUP_TIMEOUT_MS).catch(() => ({ fromComments: undefined, fromPosts: undefined })),
      withTimeout(user.getComments({ sort: 'new', limit: 25 }).then((listing) => listing.all()), USER_LOOKUP_TIMEOUT_MS).catch(() => [] as Array<{ subredditName?: string; score?: number }>),
      withTimeout(user.getPosts({ sort: 'new', limit: 25 }).then((listing) => listing.all()), USER_LOOKUP_TIMEOUT_MS).catch(() => [] as Array<{ subredditName?: string }>),
    ]);
    const createdAtIso = typeof user.createdAt?.toISOString === 'function' ? user.createdAt.toISOString() : null;
    return {
      username,
      createdAtIso,
      accountAgeDays: user.createdAt instanceof Date ? Math.max(0, Math.floor((Date.now() - user.createdAt.getTime()) / 86400000)) : null,
      linkKarma: Number.isFinite(user.linkKarma) ? user.linkKarma : null,
      commentKarma: Number.isFinite(user.commentKarma) ? user.commentKarma : null,
      subredditLinkKarma: Number.isFinite(subKarma.fromPosts ?? NaN) ? (subKarma.fromPosts ?? null) : null,
      subredditCommentKarma: Number.isFinite(subKarma.fromComments ?? NaN) ? (subKarma.fromComments ?? null) : null,
      recentPostCount: posts.length,
      recentCommentCount: comments.length,
      recentNegativeCommentCount: comments.filter((item) => (item.score ?? 0) < 0).length,
      hasVerifiedEmail: typeof user.hasVerifiedEmail === 'boolean' ? user.hasVerifiedEmail : null,
      isModerator: typeof user.isModerator === 'boolean' ? user.isModerator : null,
    };
  } catch {
    return null;
  }
}

export function evaluateRequirement(requirement: PostingRequirement, signals: UserSignals): { met: boolean; value: number | null } {
  const totalKarma = (signals.linkKarma ?? 0) + (signals.commentKarma ?? 0);
  switch (requirement.kind) {
    case 'karma': return { met: totalKarma >= requirement.minimum, value: totalKarma };
    case 'comment_karma': return { met: (signals.commentKarma ?? 0) >= requirement.minimum, value: signals.commentKarma };
    case 'link_karma': return { met: (signals.linkKarma ?? 0) >= requirement.minimum, value: signals.linkKarma };
    case 'account_age_days': return { met: (signals.accountAgeDays ?? 0) >= requirement.minimum, value: signals.accountAgeDays };
    case 'post_count': return { met: (signals.recentPostCount ?? 0) >= requirement.minimum, value: signals.recentPostCount };
    case 'comment_count': return { met: (signals.recentCommentCount ?? 0) >= requirement.minimum, value: signals.recentCommentCount };
  }
}

export async function probePostingRestrictionKarmaGate(input: {
  sub: string;
  username?: string;
  seedHint?: string;
}): Promise<KarmaGateContext | undefined> {
  const policy = await readPolicyContext(input.sub);
  const karmaRequirements = policy.postingRequirements.filter((req) => isKarmaRequirementKind(req.kind));
  if (karmaRequirements.length === 0) return undefined;

  const userSignals = await readUserSignals(input.username);
  if (!userSignals) return undefined;

  const failedKinds = new Set<PostingRequirementKind>();
  for (const requirement of karmaRequirements) {
    const evaluation = evaluateRequirement(requirement, userSignals);
    if (!evaluation.met) failedKinds.add(requirement.kind);
  }
  if (failedKinds.size === 0) return undefined;

  return {
    hasConfirmedKarmaGateFailure: true,
    failedRequirementKinds: Array.from(failedKinds),
    ...(input.seedHint ? { seedHint: input.seedHint } : {}),
  };
}

function buildRequirementGateResult(policy: SubredditPolicyContext, signals: UserSignals): DraftPreflightResult | null {
  for (const requirement of policy.postingRequirements) {
    const evaluation = evaluateRequirement(requirement, signals);
    if (evaluation.met) continue;
    const observed = evaluation.value === null ? 'unknown' : `${evaluation.value}`;
    return {
      verdict: 'disallow',
      rationale: `Subreddit rules/automod require ${requirement.minimum}+ ${requirementKindLabel(requirement.kind)}, but the user is at ${observed}.`,
      guidance: 'Do not help bypass the rule. Tell them the current account history does not meet the posting requirement.',
      templateTitle: '',
      templateBody: '',
      citations: [requirement.raw || getPolicyRequirementSummary([requirement])],
      bypassRisk: false,
      usedModel: 'rules-gate',
      usedProModel: false,
    };
  }
  return null;
}

function fallbackResult(input: DraftPreflightInput, model: string): DraftPreflightResult {
  const bypassRisk = looksLikeBypassRequest(`${input.question}\n${input.draftTitle}\n${input.draftBody}`);
  return {
    verdict: bypassRisk ? 'disallow' : 'gray',
    rationale: bypassRisk
      ? 'Request looks like rule-evasion intent; provide compliance-only guidance.'
      : 'Insufficient confidence for yes/no; advise caution and compliance-first edits.',
    guidance: bypassRisk
      ? 'We cannot help bypass rules. Rewrite your draft to follow posted subreddit and automod requirements.'
      : 'This may be a gray area. Ask a human mod before posting and keep title/body tightly aligned to subreddit rules.',
    templateTitle: '',
    templateBody: '',
    citations: [],
    bypassRisk,
    usedModel: model,
    usedProModel: model.includes('pro'),
  };
}

export async function runDraftPreflight(input: DraftPreflightInput): Promise<DraftPreflightContext> {
  const [policy, removedSamples, keyResolution, userSignals] = await Promise.all([
    readPolicyContext(input.sub),
    readRemovedSamples(input),
    resolveAiKey(input.sub),
    readUserSignals(input.username),
  ]);

  if (userSignals) {
    const gated = buildRequirementGateResult(policy, userSignals);
    if (gated) {
      return {
        input,
        policy,
        removedSamples,
        userSignals,
        result: gated,
      };
    }
  }

  if (!keyResolution.ok) {
    return {
      input,
      policy,
      removedSamples,
      userSignals,
      result: fallbackResult(input, 'no-ai-key'),
    };
  }

  try {
    const ai = await callDraftPreflight({
      apiKey: keyResolution.apiKey,
      input,
      policy,
      removedSamples,
      userSignals,
    });
    return {
      input,
      policy,
      removedSamples,
      userSignals,
      result: ai,
    };
  } catch {
    return {
      input,
      policy,
      removedSamples,
      userSignals,
      result: fallbackResult(input, 'preflight-fallback'),
    };
  }
}
