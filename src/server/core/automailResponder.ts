// SPDX-License-Identifier: GPL-3.0-only
// Generates one Mod Mail reply via @ai callResponder. Stateless - caller
// is responsible for delivering the reply and any side effect actions.

import {
  AUTOMAIL_REPLY_MAX,
  GENERATED_SIGNATURE_DEFAULT,
  type AutoMailReplyMode,
  pmThresholdAllowsLevel,
  type PmThreshold,
  type AutoMailUserShortcut,
  type DraftPreflightContext,
  type EvidenceBundle,
  type KarmaGateContext,
  type SeverityResult,
} from '../../shared/automail';
import { buildResponderSystemInstruction, callDecisionValidator, callResponder } from '@ai';
import type { ResponderConversationTurn } from '../ai-public/genaiClient';
import { resolveAiKey } from './aiRuntime';
import { getUserConversationHistory, setUserConversationHistory } from './automailStore';
import { waitMs } from './actionPacing';
import { buildOfficialRulesPromptBlock, getSubredditRulesContext } from './subredditRules';
import { formatRelevantLinksSection, selectHelpfulLinks, shouldIncludeHelpfulLinks } from './referenceLinks';

export type ResponderTurn = {
  role: 'user' | 'mod' | 'ai';
  author: string;
  body: string;
  ts: number;
};

export type ResponderInput = {
  sub: string;
  conversationId: string;
  conversationSubject: string;
  participantUser: string;
  messages: ResponderTurn[];
  mode: AutoMailReplyMode;
  tonePrompt: string;
  appUsername: string;
  generatedSignature?: string;
  pmModsThreshold?: PmThreshold;
  severity?: SeverityResult;
  evidence?: EvidenceBundle;
  preflight?: DraftPreflightContext;
  karmaGate?: KarmaGateContext;
};

export type ResponderOutput = {
  body: string;
  actions: {
    markResolved: boolean;
    markResolvedReason?: string;
    flagForLivemod: boolean;
    flagForLivemodReason?: string;
    archive: boolean;
    archiveReason?: string;
  };
  tokens: number;
};

const CONTINUE_REPLY_RETRY_INTERVAL_MS = 2500;
const CONTINUE_REPLY_MAX_ATTEMPTS = 12;
const WEAK_REPLY_ACCEPT_THRESHOLD = 8;

const SHORTCUT_RE = /^\s*-(archive|rep)\b/im;

export function parseUserShortcut(body: string): AutoMailUserShortcut {
  const m = body.match(SHORTCUT_RE);
  if (!m) return null;
  const tok = m[1]?.toLowerCase();
  return tok === 'archive' || tok === 'rep' ? tok : null;
}

const AI_TELL_PATTERNS: RegExp[] = [
  /^\s*(certainly!?|of course!?|absolutely!?)/i,
  /\bas an ai\b/i,
  /\bi am an ai\b/i,
  /\bi'm an ai\b/i,
  /\bas a language model\b/i,
];

const ACTION_CLAIM_PATTERNS: RegExp[] = [
  /\bwe\s+(?:have\s+)?(?:removed|deleted|took down|taken down)\b[^.\n]*[.]?/gi,
  /\b(?:your|the)\s+(?:photo|image|post|comment)\s+(?:has been|was)\s+(?:removed|deleted|taken down)\b[^.\n]*[.]?/gi,
  /\bwe\s+(?:have\s+)?(?:banned|suspended|locked)\b[^.\n]*[.]?/gi,
];

const MODERATOR_FOLLOWUP_RE =
  /(?:human\s+moderator|moderator\s+will\s+(?:review|follow\s+up)|mod\s+team)/i;

const WEAK_CONTINUE_REPLY_RE = /^(?:thanks(?: for your message)?[.!]?\s*)?(?:a )?(?:human moderator has been notified to review this (?:report|urgently)|moderator will review this conversation and follow up shortly|a moderator will review this conversation and follow up shortly|a human moderator will follow up(?: here)? shortly)\.?$/i;

export function sanitizeAiTells(text: string): string {
  let out = text;
  for (const re of AI_TELL_PATTERNS) out = out.replace(re, '');
  out = out.replace(/[\u2014\u2013]/g, '--');
  out = out.replace(/[\u2018\u2019]/g, "'");
  out = out.replace(/[\u201C\u201D]/g, '"');
  out = out.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function clampReply(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= AUTOMAIL_REPLY_MAX) return trimmed;
  return trimmed.slice(0, AUTOMAIL_REPLY_MAX - 1) + '...';
}

function neutralizeUnverifiedActionClaims(text: string): string {
  let out = text;
  for (const re of ACTION_CLAIM_PATTERNS) {
    out = out.replace(re, 'A human moderator has been notified to review this urgently.');
  }
  return out;
}

function ensureGeneratedSignature(text: string, signature?: string): string {
  const sig = (signature ?? GENERATED_SIGNATURE_DEFAULT).trim() || GENERATED_SIGNATURE_DEFAULT;
  const trimmed = text.trim();
  if (!trimmed) return sig;
  if (trimmed.includes(sig)) return trimmed;
  return `${trimmed}\n\n${sig}`;
}

function removeGeneratedSignature(text: string, signature?: string): string {
  const sig = (signature ?? GENERATED_SIGNATURE_DEFAULT).trim() || GENERATED_SIGNATURE_DEFAULT;
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (!trimmed.endsWith(sig)) return trimmed;
  return trimmed.slice(0, trimmed.length - sig.length).trim();
}

function isWeakContinueReply(text: string, signature?: string): boolean {
  const withoutSig = removeGeneratedSignature(text, signature);
  const normalized = withoutSig.replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  return WEAK_CONTINUE_REPLY_RE.test(normalized);
}

function previewForLog(text: string, max = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function summarizeToolCallsForLog(toolCalls: Array<{ name?: string; args?: unknown }>): string {
  if (!toolCalls.length) return 'none';
  return toolCalls
    .map((tc) => {
      const name = (tc.name ?? 'unknown').trim() || 'unknown';
      const reason =
        tc.args && typeof tc.args === 'object' && 'reason' in tc.args
          ? String((tc.args as { reason?: unknown }).reason ?? '').trim()
          : '';
      if (!reason) return name;
      return `${name}(${previewForLog(reason, 80)})`;
    })
    .join(', ');
}

function enforcePreflightCompliance(text: string, preflight?: DraftPreflightContext): string {
  if (!preflight) return text;
  const lower = text.toLowerCase();
  const bad = /bypass|evade|get around|avoid detection|trick automod|sneak past/;
  if (bad.test(lower) || preflight.result.bypassRisk || preflight.result.verdict === 'disallow') {
    return [
      'Thanks for checking before posting.',
      'We cannot help with bypassing subreddit rules or automod checks.',
      'Please follow the posted rules and ask mods for clarification if needed.',
      '',
      '-- Mod Team',
    ].join('\n');
  }
  return text;
}

function latestUserMessageText(messages: ResponderTurn[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === 'user') return msg.body ?? '';
  }
  return '';
}

function ensureHelpfulLinkSection(text: string, section: string, required: boolean): string {
  const trimmed = text.trim();
  if (!trimmed || !section.trim()) return trimmed;
  if (/^###\s+relevant\s+links\b/im.test(trimmed)) return trimmed;
  if (!required) return trimmed;
  return `${trimmed}\n\n${section}`.trim();
}

function toApiTurns(input: ResponderInput): ResponderConversationTurn[] {
  return input.messages.slice(-10).map((m) => {
    const authorIsApp = m.role === 'ai';
    const authorIsMod = m.role === 'mod';
    const role: 'user' | 'mod' | 'app' = authorIsApp ? 'app' : authorIsMod ? 'mod' : 'user';
    return {
      role,
      authorIsMod,
      authorIsApp,
      authorName: m.author,
      body: m.body.replace(/\s+/g, ' ').slice(0, 1500),
      createdAtIso: new Date(m.ts).toISOString(),
    };
  });
}

export type GenerateReplyOnceResult = ResponderOutput & {
  validatorSuggestedReply?: string;
  responderTextWasEmpty?: boolean;
};

async function generateReplyOnce(args: {
  input: ResponderInput;
  system: string;
  mergedConversation: ResponderConversationTurn[];
  apiKey: string;
}): Promise<GenerateReplyOnceResult> {
  const { input, system, mergedConversation, apiKey } = args;
  const result = await callResponder({
    apiKey,
    system,
    conversation: mergedConversation,
    mode: input.mode,
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.preflight ? { preflight: input.preflight.result } : {}),
  });
  const responderTokens = result.candidatesTokenCount + result.promptTokenCount;
  console.log(
    `[MG/responder] responder_complete sub=${input.sub} conversationId=${input.conversationId} mode=${input.mode} tokens=${responderTokens} toolCalls=${result.toolCalls.length} textLength=${result.text.length} textPreview="${previewForLog(result.text)}" toolSummary="${summarizeToolCallsForLog(result.toolCalls)}"`
  );

  let markResolved = false;
  let markResolvedReason: string | undefined;
  let flagForLivemod = false;
  let flagForLivemodReason: string | undefined;
  for (const fc of result.toolCalls) {
    if (fc.name === 'mark_resolved') {
      markResolved = true;
      if (!markResolvedReason && typeof fc.args.reason === 'string' && fc.args.reason.trim().length > 0) {
        markResolvedReason = fc.args.reason.trim();
      }
    } else if (fc.name === 'flag_for_livemod') {
      flagForLivemod = true;
      if (!flagForLivemodReason && typeof fc.args.reason === 'string' && fc.args.reason.trim().length > 0) {
        flagForLivemodReason = fc.args.reason.trim();
      }
    }
  }

  const mustMentionModeratorNotification = !!(
    input.severity &&
    input.pmModsThreshold !== undefined &&
    pmThresholdAllowsLevel(input.pmModsThreshold, input.severity.level)
  );
  if (mustMentionModeratorNotification) {
    flagForLivemod = true;
    if (!flagForLivemodReason) {
      flagForLivemodReason = `severity level ${input.severity?.level ?? 'n/a'} meets threshold ${input.pmModsThreshold ?? 'n/a'}`;
    }
    markResolved = false;
  }
  console.log(
    `[MG/responder] action_flags sub=${input.sub} conversationId=${input.conversationId} mode=${input.mode} markResolved=${markResolved} flagForLivemod=${flagForLivemod} mustMentionModeratorNotification=${mustMentionModeratorNotification}`
  );

  let body = sanitizeAiTells(result.text.trim());
  body = neutralizeUnverifiedActionClaims(body);
  body = enforcePreflightCompliance(body, input.preflight);
  const responderTextWasEmpty = !body || isWeakContinueReply(body, input.generatedSignature);
  const bodyBeforeValidator = body;
  if (input.mode === 'archive-ack' && !body) {
    body = 'Thanks for reaching out. We are closing this conversation; reply again any time if anything changes.\n\n-- Mod Team';
  }
  if (input.mode === 'livemod-ack' && !body) {
    body = 'Thanks. A human moderator will follow up here shortly.\n\n-- Mod Team';
  }
  if (input.mode === 'continue' && !body) {
    body = 'Thanks for your message. A moderator will review this conversation and follow up shortly.';
  }
  if ((flagForLivemod || mustMentionModeratorNotification) && !MODERATOR_FOLLOWUP_RE.test(body)) {
    body = `${body}\n\nA human moderator has been notified to review this urgently.`;
  }

  let validatorSuggestedReply: string | undefined;
  if (input.mode === 'continue') {
    const validatorToolCalls = [...result.toolCalls];
    if (mustMentionModeratorNotification && !validatorToolCalls.some((tc) => tc.name === 'flag_for_livemod')) {
      validatorToolCalls.push({
        name: 'flag_for_livemod',
        args: { reason: `severity meets threshold ${input.pmModsThreshold ?? 'n/a'}` },
      });
    }
    console.log(
      `[MG/responder] validator_start sub=${input.sub} conversationId=${input.conversationId} mode=${input.mode} bodyPreview="${previewForLog(body)}"`
    );
    const validator = await callDecisionValidator({
      apiKey,
      system,
      conversationSubject: input.conversationSubject,
      conversation: mergedConversation,
      mode: input.mode,
      ...(input.severity ? { severity: input.severity } : {}),
      responderText: body,
      responderToolCalls: validatorToolCalls,
      mustMentionModeratorNotification,
    });
    console.log(
      `[MG/responder] validator_result sub=${input.sub} conversationId=${input.conversationId} mode=${input.mode} forceLivemod=${validator.forceLivemod} reason="${previewForLog(validator.reason)}" hasSuggestedReply=${Boolean(validator.suggestedReply && validator.suggestedReply.trim().length > 0)} suggestedReplyPreview="${previewForLog(validator.suggestedReply ?? '')}"`
    );
    const suggested = validator.suggestedReply?.trim();
    if (suggested && suggested.length > 0) {
      validatorSuggestedReply = suggested;
      body = suggested;
    }
    if (validator.forceLivemod) {
      flagForLivemod = true;
      if (!flagForLivemodReason) {
        const reason = validator.reason?.trim();
        if (reason) flagForLivemodReason = reason;
      }
      markResolved = false;
      if (!MODERATOR_FOLLOWUP_RE.test(body)) {
        body = `${body}\n\nA human moderator has been notified to review this report.`.trim();
      }
    }
    if (!body.trim()) {
      body = bodyBeforeValidator || body;
    }
  }

  body = sanitizeAiTells(body);
  body = neutralizeUnverifiedActionClaims(body);
  body = enforcePreflightCompliance(body, input.preflight);
  if ((flagForLivemod || mustMentionModeratorNotification) && !MODERATOR_FOLLOWUP_RE.test(body)) {
    body = `${body}\n\nA human moderator has been notified to review this urgently.`;
  }

  const helpfulLinkContext = {
    sub: input.sub,
    latestUserText: latestUserMessageText(input.messages),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.preflight ? { preflight: input.preflight } : {}),
    ...(input.karmaGate ? { karmaGate: input.karmaGate } : {}),
  };
  const links = selectHelpfulLinks(helpfulLinkContext);
  const mustIncludeHelpfulLinks = shouldIncludeHelpfulLinks(helpfulLinkContext);
  body = ensureHelpfulLinkSection(body, formatRelevantLinksSection(links), mustIncludeHelpfulLinks);

  body = ensureGeneratedSignature(body, input.generatedSignature);
  body = clampReply(body);

  const archive = input.mode === 'archive-ack' || markResolved;
  const archiveReason = archive
    ? (markResolvedReason || (input.mode === 'archive-ack' ? 'archive acknowledgement mode selected' : 'resolver action selected'))
    : undefined;
  const actions: ResponderOutput['actions'] = {
    markResolved,
    ...(markResolvedReason ? { markResolvedReason } : {}),
    flagForLivemod,
    ...(flagForLivemodReason ? { flagForLivemodReason } : {}),
    archive,
    ...(archiveReason ? { archiveReason } : {}),
  };
  console.log(
    `[MG/responder] final_reply sub=${input.sub} conversationId=${input.conversationId} mode=${input.mode} bodyLength=${body.length} bodyPreview="${previewForLog(body)}" archive=${archive} flagForLivemod=${flagForLivemod}`
  );
  return {
    body,
    actions,
    tokens: responderTokens,
    ...(validatorSuggestedReply ? { validatorSuggestedReply } : {}),
    responderTextWasEmpty,
  };
}

export async function generateReply(input: ResponderInput): Promise<ResponderOutput> {
  const [rulesCtx, keyResolution, priorHistory] = await Promise.all([
    getSubredditRulesContext(input.sub),
    resolveAiKey(input.sub),
    getUserConversationHistory(input.sub, input.participantUser),
  ]);
  if (!keyResolution.ok) throw new Error(`NO_AI_KEY: ${keyResolution.error}`);

  const rulesBlock = buildOfficialRulesPromptBlock(rulesCtx.rulesText);
  const system = buildResponderSystemInstruction({
    sub: input.sub,
    tonePrompt: input.tonePrompt,
    rulesBlock,
    mode: input.mode,
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.preflight ? { preflight: input.preflight.result } : {}),
  });

  const currentTurns = toApiTurns(input);
  const mergedConversation = [...priorHistory, ...currentTurns].slice(-24);
  console.log(
    `[MG/responder] generate_start sub=${input.sub} conversationId=${input.conversationId} mode=${input.mode} incomingTurns=${currentTurns.length} priorHistory=${priorHistory.length} mergedTurns=${mergedConversation.length}`
  );

  let out: ResponderOutput | undefined;
  let lastErr: unknown;
  let lastValidatorSuggestedReply: string | undefined;
  let consecutiveEmptyResponderAttempts = 0;
  for (let attempt = 1; attempt <= CONTINUE_REPLY_MAX_ATTEMPTS; attempt += 1) {
    console.log(
      `[MG/responder] attempt_start sub=${input.sub} conversationId=${input.conversationId} mode=${input.mode} attempt=${attempt}/${CONTINUE_REPLY_MAX_ATTEMPTS}`
    );
    try {
      const result = await generateReplyOnce({
        input,
        system,
        mergedConversation,
        apiKey: keyResolution.apiKey,
      });
      lastValidatorSuggestedReply = result.validatorSuggestedReply ?? lastValidatorSuggestedReply;
      // Track whether the responder itself is consistently returning empty/weak text
      // (the actual bug condition: responder returns only tool calls, no substantive text)
      if (result.responderTextWasEmpty) {
        consecutiveEmptyResponderAttempts += 1;
      } else {
        consecutiveEmptyResponderAttempts = 0;
      }
      out = result;
      if (input.mode !== 'continue' || !isWeakContinueReply(out.body, input.generatedSignature)) {
        break;
      }
      console.warn(
        `[MG/responder] weak_continue_reply sub=${input.sub} conversationId=${input.conversationId} attempt=${attempt} bodyPreview="${previewForLog(out.body)}"`
      );
      // Only accept the weak validator suggestion after threshold if the responder
      // has CONSISTENTLY failed to produce substantive text (the actual bug condition:
      // responder returns empty text + tool calls on every attempt)
      if (
        attempt >= WEAK_REPLY_ACCEPT_THRESHOLD &&
        consecutiveEmptyResponderAttempts >= WEAK_REPLY_ACCEPT_THRESHOLD &&
        lastValidatorSuggestedReply
      ) {
        console.log(
          `[MG/responder] weak_reply_threshold_accept sub=${input.sub} conversationId=${input.conversationId} attempt=${attempt} consecutiveEmpty=${consecutiveEmptyResponderAttempts} acceptedReply="${previewForLog(lastValidatorSuggestedReply)}"`
        );
        out.body = ensureGeneratedSignature(lastValidatorSuggestedReply, input.generatedSignature);
        out.body = clampReply(out.body);
        break;
      }
      lastErr = new Error('WEAK_CONTINUE_REPLY');
      out = undefined;
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[MG/responder] attempt_error sub=${input.sub} conversationId=${input.conversationId} mode=${input.mode} attempt=${attempt} message="${previewForLog(message, 240)}"`
      );
    }
    if (attempt < CONTINUE_REPLY_MAX_ATTEMPTS && input.mode === 'continue') {
      console.log(
        `[MG/responder] retry_scheduled sub=${input.sub} conversationId=${input.conversationId} intervalMs=${CONTINUE_REPLY_RETRY_INTERVAL_MS} nextAttempt=${attempt + 1}`
      );
      await waitMs(CONTINUE_REPLY_RETRY_INTERVAL_MS);
    }
  }

  if (!out) {
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
    console.warn(
      `[MG/responder] retry_exhausted sub=${input.sub} conversationId=${input.conversationId} mode=${input.mode} lastError="${previewForLog(message, 240)}"`
    );
    if (input.mode === 'continue') {
      if (lastValidatorSuggestedReply) {
        console.log(
          `[MG/responder] last_resort_fallback sub=${input.sub} conversationId=${input.conversationId} using validator suggestion as fallback`
        );
        const fallbackBody = clampReply(
          ensureGeneratedSignature(lastValidatorSuggestedReply, input.generatedSignature)
        );
        return {
          body: fallbackBody,
          actions: {
            markResolved: false,
            flagForLivemod: true,
            flagForLivemodReason: 'validator suggested fallback after retry exhaustion',
            archive: false,
          },
          tokens: 0,
        };
      }
      throw new Error('REPLY_RETRY_EXHAUSTED');
    }
    throw (lastErr instanceof Error ? lastErr : new Error('REPLY_GENERATION_EXHAUSTED'));
  }

  const assistantTurn: ResponderConversationTurn = {
    role: 'app',
    authorIsMod: false,
    authorIsApp: true,
    authorName: input.appUsername,
    body: out.body,
    createdAtIso: new Date().toISOString(),
  };
  await setUserConversationHistory(input.sub, input.participantUser, [...mergedConversation, assistantTurn]);
  console.log(
    `[MG/responder] history_persisted sub=${input.sub} conversationId=${input.conversationId} mode=${input.mode} historyTurns=${mergedConversation.length + 1} finalTokens=${out.tokens}`
  );
  return out;
}

export const FINAL_HANDOFF_BODY = 'A human moderator will follow up.\n\n-- Mod Team';

