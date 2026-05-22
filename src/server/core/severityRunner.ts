// SPDX-License-Identifier: GPL-3.0-only
// Severity runner: classifies one inbound message via the @ai severity
// pipeline, caches the result per messageId, and applies pacing + retry.

import {
  buildSeveritySystemInstruction,
  callSeverity,
} from '@ai';
import type { ResponderConversationTurn } from '../ai-public/genaiClient';
import { SEVERITY_RATIONALE_MAX, type SeverityCategory, type SeverityResult } from '../../shared/automail';
import { resolveAiKey } from './aiRuntime';
import { delayBeforeAction, waitMs, withRateLimitRetry, withTimeout } from './actionPacing';
import { buildOfficialRulesPromptBlock, getSubredditRulesContext } from './subredditRules';
import { getCachedSeverity, setCachedSeverity } from './automailStore';

const SEVERITY_TIMEOUT_MS = 4000;
const HIGH_RISK_DOXX_RE = /\b(dox+|doxxing|posted\s+my\s+(?:number|address)|shared\s+my\s+(?:phone|number|address)|phone\s*number|home\s*address|street\s*address|personal\s+info|private\s+info|pii)\b/i;
const HIGH_RISK_THREAT_RE = /\b(threat|threaten|kill\s+me|hurt\s+me|stalk(?:ing)?|unsafe|in\s+danger)\b/i;

function latestUserText(conversation: ResponderConversationTurn[]): string {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const turn = conversation[i];
    if (!turn) continue;
    if (!turn.authorIsMod && !turn.authorIsApp) return turn.body ?? '';
  }
  return '';
}

function applyHighRiskFallback(raw: Awaited<ReturnType<typeof callSeverity>>, conversation: ResponderConversationTurn[]): Awaited<ReturnType<typeof callSeverity>> {
  const defaultLike =
    raw.level === 1 &&
    raw.categories.length === 0 &&
    raw.claims.length === 0 &&
    (raw.rationale ?? '').trim().length === 0;

  const text = latestUserText(conversation);
  if (!text) return raw;

  const inferredCategories: SeverityCategory[] = [];
  let level = raw.level as number;
  const hasDoxxSignal = HIGH_RISK_DOXX_RE.test(text);
  const hasThreatSignal = HIGH_RISK_THREAT_RE.test(text);
  if (hasDoxxSignal) {
    inferredCategories.push('doxxing');
    level = Math.max(level, 3);
  }
  if (hasThreatSignal) {
    inferredCategories.push('threat');
    level = Math.max(level, 4);
  }
  if (inferredCategories.length === 0) return raw;

  const isUnderscored =
    defaultLike ||
    (hasDoxxSignal && (raw.level < 3 || !raw.categories.includes('doxxing'))) ||
    (hasThreatSignal && (raw.level < 4 || !raw.categories.includes('threat')));
  if (!isUnderscored) return raw;

  const mergedCategories = [...raw.categories];
  for (const cat of inferredCategories) {
    if (!mergedCategories.includes(cat)) mergedCategories.push(cat);
  }

  const existingDebug = raw.debug;
  const fallbackPreview = `[severity-diagnostic] high-risk-fallback:${inferredCategories.join('+')}`;
  const debug = existingDebug
    ? {
        ...existingDebug,
        parts: [
          ...existingDebug.parts,
          { kind: 'text' as const, thought: false, textPreview: fallbackPreview },
        ],
      }
    : undefined;

  return {
    ...raw,
    level: level as 1 | 2 | 3 | 4 | 5,
    categories: mergedCategories,
    claims: raw.claims.length > 0 ? raw.claims : ['none'],
    rationale: 'fallback: high-risk privacy/safety terms found in latest user message',
    ...(debug ? { debug } : {}),
  };
}

export type ClassifyArgs = {
  sub: string;
  messageId: string;
  conversationSubject: string;
  conversation: ResponderConversationTurn[];
};

export async function classifyMessage(args: ClassifyArgs): Promise<SeverityResult> {
  const cached = await getCachedSeverity(args.sub, args.messageId);
  if (cached) return cached;

  const [rulesCtx, keyResolution] = await Promise.all([
    getSubredditRulesContext(args.sub),
    resolveAiKey(args.sub),
  ]);
  if (!keyResolution.ok) throw new Error(`NO_AI_KEY: ${keyResolution.error}`);

  const system = buildSeveritySystemInstruction({
    sub: args.sub,
    rulesBlock: buildOfficialRulesPromptBlock(rulesCtx.rulesText),
  });

  await waitMs(delayBeforeAction('ai-severity', true));
  const raw = await withTimeout(
    () => withRateLimitRetry(
      () => callSeverity({
        apiKey: keyResolution.apiKey,
        system,
        conversationSubject: args.conversationSubject,
        conversation: args.conversation,
      }),
      { actionType: 'ai-severity', sub: args.sub, thingId: args.messageId },
    ),
    SEVERITY_TIMEOUT_MS,
    { actionType: 'ai-severity', sub: args.sub, thingId: args.messageId },
  );
  const normalized = applyHighRiskFallback(raw, args.conversation);

  const rationale = (normalized.rationale ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .slice(0, SEVERITY_RATIONALE_MAX);
  const result: SeverityResult = {
    level: normalized.level,
    categories: normalized.categories,
    rationale,
    claims: normalized.claims,
    generatedAt: Date.now(),
    ...(normalized.userProfile ? { userProfile: normalized.userProfile } : {}),
    ...(normalized.subredditContext ? { subredditContext: normalized.subredditContext } : {}),
  };
  await setCachedSeverity(args.sub, args.messageId, result);
  return result;
}
