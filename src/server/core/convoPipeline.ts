// SPDX-License-Identifier: GPL-3.0-only
// Per-convo pipeline shared by runScan and processInboundModmail.
//
// Order is fixed:
//   1. cap-check  (replies >= maxReplies => final handoff + archive)
//   2. severity classification (cached per messageId)
//   3. csam short-circuit (neutral ack + plausible-cause-gated archive/PM)
//   4. evidence (per requested claims)
//   5. responder (with severity+evidence)
//   6. INCR reply counter on success
//   7. transcript runs LAST per convo, gated on remaining budget

import type {
  AutoMailReplyMode,
  AutoMailScanState,
  AutoMailSettings,
  DraftCandidate,
  DraftPreflightContext,
  DraftPreflightSource,
  KarmaGateContext,
  PmThreshold,
} from '../../shared/automail';
import { GENERATED_SIGNATURE_DEFAULT } from '../../shared/automail';
import {
  buildCsamNeutralAck,
} from '@ai';
import type { ResponderConversationTurn } from '../ai-public/genaiClient';
import { delayBeforeAction, waitMs, withRateLimitRetry } from './actionPacing';
import { generateReply, type ResponderTurn, FINAL_HANDOFF_BODY } from './automailResponder';
import { classifyMessage } from './severityRunner';
import { evaluateCsamPlausibleCause, runEvidence } from './evidence';
import { extractDraftCandidateFromText } from './draftExtraction';
import { probePostingRestrictionKarmaGate, runDraftPreflight } from './draftPreflight';
import { maybePmMods, postDetailedConvoReport } from './modPm';
import { generateAndStoreTranscript } from './transcriptRunner';
import {
  claimFinalHandoff,
  getReplyCount,
  incrReplyCount,
  setConvoState,
  getConvoState,
} from './automailStore';

export const SCAN_SOFT_DEADLINE_MS = 36_000;
export const TRANSCRIPT_BUDGET_MIN_MS = 6_000;

export type MmReplyApi = {
  reply: (p: { conversationId: string; body: string; isInternal?: boolean; isAuthorHidden?: boolean }) => Promise<unknown>;
  archiveConversation: (id: string) => Promise<unknown>;
  highlightConversation: (id: string) => Promise<unknown>;
};

export type ProcessOneArgs = {
  sub: string;
  conversationId: string;
  conversationSubject: string;
  participantUser: string;
  participantThingId?: string;
  lastMessageId: string | null;
  lastUserBody: string;
  mode: AutoMailReplyMode;
  state: AutoMailScanState;
  turns: ResponderTurn[];
  apiTurns: ResponderConversationTurn[];
  tonePrompt: string;
  appUsername: string;
  settings: AutoMailSettings;
  api: MmReplyApi;
  scanStartedAt: number;
  draftCandidate?: DraftCandidate | null;
  draftPreflightSource?: DraftPreflightSource;
};

export type ProcessOneResult = {
  acted: boolean;
  reason: string;
  replied: boolean;
  archived: boolean;
  flagged: boolean;
  finalHandoff: boolean;
  csam: boolean;
  preflightVerdict?: 'allow' | 'disallow' | 'gray';
};

function withGeneratedSignature(body: string, signature?: string): string {
  const sig = (signature ?? GENERATED_SIGNATURE_DEFAULT).trim() || GENERATED_SIGNATURE_DEFAULT;
  const trimmed = body.trim();
  if (!trimmed) return sig;
  if (trimmed.includes(sig)) return trimmed;
  return `${trimmed}\n\n${sig}`;
}

function remainingBudget(scanStartedAt: number): number {
  return SCAN_SOFT_DEADLINE_MS - (Date.now() - scanStartedAt);
}

function looksLikePostingRestrictionQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  const asksAboutPosting = /\b(can i post|am i allowed to post|allowed to post|post this|before i post|post here|able to post|cannot post|can't post|why was my post removed|posting requirements?)\b/.test(lower);
  const mentionsGateTerms = /\b(karma|comment karma|link karma|minimum karma|account age|days old|new account|requirements?|restrictions?)\b/.test(lower);
  return asksAboutPosting || mentionsGateTerms;
}

export async function processOneConvo(args: ProcessOneArgs): Promise<ProcessOneResult> {
  const result: ProcessOneResult = {
    acted: false,
    reason: '',
    replied: false,
    archived: false,
    flagged: false,
    finalHandoff: false,
    csam: false,
  };
  const userTurnCount = args.apiTurns.filter((turn) => turn.role === 'user').length;

  const count = await getReplyCount(args.sub, args.conversationId);
  if (args.mode === 'continue' && count >= args.settings.maxReplies) {
    const claimed = await claimFinalHandoff(args.sub, args.conversationId);
    if (!claimed) {
      result.reason = 'cap-already-handed-off';
      return result;
    }
    try {
      const handoffBody = withGeneratedSignature(FINAL_HANDOFF_BODY, args.settings.generatedSignature);
      await waitMs(delayBeforeAction('modmail-reply', true));
      await withRateLimitRetry(
        () => args.api.reply({ conversationId: args.conversationId, body: handoffBody, isInternal: false }),
        { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
      );
      result.replied = true;
    } catch (e) {
      result.reason = `final-handoff-reply-failed:${(e as Error)?.message ?? 'err'}`;
      return result;
    }
    try {
      await waitMs(delayBeforeAction('modmail-highlight', true));
      await withRateLimitRetry(
        () => args.api.highlightConversation(args.conversationId),
        { actionType: 'modmail-highlight', sub: args.sub, thingId: args.conversationId },
      );
    } catch { /* best-effort */ }
    try {
      await waitMs(delayBeforeAction('modmail-archive', true));
      await withRateLimitRetry(
        () => args.api.archiveConversation(args.conversationId),
        { actionType: 'modmail-archive', sub: args.sub, thingId: args.conversationId },
      );
    } catch { /* best-effort */ }
    result.acted = true;
    result.archived = true;
    result.flagged = true;
    result.finalHandoff = true;
    result.reason = 'final-handoff';
    try {
      await postDetailedConvoReport({
        sub: args.sub,
        conversationId: args.conversationId,
        conversationSubject: args.conversationSubject,
        participantUser: args.participantUser,
        mode: args.mode,
        reason: result.reason,
        bodyExcerpt: args.lastUserBody,
        finalReply: FINAL_HANDOFF_BODY,
        userTurnCount,
        actions: { markResolved: false, flagForLivemod: true, archive: true },
      });
    } catch (e) {
      console.warn('[amu/pipeline] detailed report failed:', (e as Error)?.message);
    }
    return result;
  }

  let severity;
  try {
    if (args.lastMessageId) {
      severity = await classifyMessage({
        sub: args.sub,
        messageId: args.lastMessageId,
        conversationSubject: args.conversationSubject,
        conversation: args.apiTurns,
      });
    }
  } catch (e) {
    console.warn('[amu/pipeline] severity failed:', (e as Error)?.message);
  }

  if (severity?.categories.includes('csam')) {
    result.csam = true;
    const ack = buildCsamNeutralAck();
    try {
      await waitMs(delayBeforeAction('modmail-reply', true));
      await withRateLimitRetry(
        () => args.api.reply({ conversationId: args.conversationId, body: ack, isInternal: false }),
        { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
      );
      result.replied = true;
    } catch (e) {
      result.reason = `csam-ack-failed:${(e as Error)?.message ?? 'err'}`;
    }
    const csamPlausible = await evaluateCsamPlausibleCause({
      sub: args.sub,
      ...(args.participantThingId ? { thingId: args.participantThingId } : {}),
      lastUserBody: args.lastUserBody,
      conversation: args.apiTurns,
    });
    if (csamPlausible.plausible) {
      try {
        await waitMs(delayBeforeAction('modmail-archive', true));
        await withRateLimitRetry(
          () => args.api.archiveConversation(args.conversationId),
          { actionType: 'modmail-archive', sub: args.sub, thingId: args.conversationId },
        );
        result.archived = true;
      } catch { /* best-effort */ }
      await maybePmMods({
        sub: args.sub,
        conversationId: args.conversationId,
        participantUser: args.participantUser,
        ...(args.participantThingId ? { thingId: args.participantThingId } : {}),
        threshold: 1 satisfies PmThreshold,
        severity,
        bodyExcerpt: args.lastUserBody,
        urgency: true,
      });
    }
    const prev = await getConvoState(args.sub, args.conversationId);
    await setConvoState(args.sub, {
      conversationId: args.conversationId,
      lastAiReplyAt: args.lastMessageId ?? prev?.lastAiReplyAt ?? null,
      awaitingResolutionDeadline: null,
      livemodFlagged: prev?.livemodFlagged ?? false,
      resolvedByAi: true,
      updatedAt: Date.now(),
    });
    result.acted = true;
    result.reason = 'csam-shortcut';
    try {
      await postDetailedConvoReport({
        sub: args.sub,
        conversationId: args.conversationId,
        conversationSubject: args.conversationSubject,
        participantUser: args.participantUser,
        mode: args.mode,
        reason: result.reason,
        bodyExcerpt: args.lastUserBody,
        finalReply: ack,
        userTurnCount,
        severity,
        actions: { markResolved: true, flagForLivemod: csamPlausible.plausible, archive: result.archived },
      });
    } catch (e) {
      console.warn('[amu/pipeline] detailed report failed:', (e as Error)?.message);
    }
    return result;
  }

  let evidence;
  let preflight: DraftPreflightContext | undefined;
  let karmaGate: KarmaGateContext | undefined;
  if (severity?.categories.includes('rules_question')) {
    const draft = args.draftCandidate ?? extractDraftCandidateFromText(args.lastUserBody);
    if (draft) {
      try {
        preflight = await runDraftPreflight({
          sub: args.sub,
          source: args.draftPreflightSource ?? 'modmail',
          question: args.lastUserBody,
          draftTitle: draft.title,
          draftBody: draft.body,
          username: args.participantUser,
        });
        result.preflightVerdict = preflight.result.verdict;
      } catch (e) {
        console.warn('[amu/pipeline] preflight failed:', (e as Error)?.message);
      }
    } else if (looksLikePostingRestrictionQuestion(args.lastUserBody)) {
      try {
        karmaGate = await withRateLimitRetry(
          () => probePostingRestrictionKarmaGate({
            sub: args.sub,
            username: args.participantUser,
            seedHint: `${args.conversationId}:${args.participantUser}`,
          }),
          { actionType: 'reddit-read', sub: args.sub, thingId: args.conversationId },
        );
      } catch (e) {
        console.warn('[amu/pipeline] karma gate probe failed:', (e as Error)?.message);
      }
    }
  }

  if (severity && severity.claims.some((c) => c !== 'none')) {
    evidence = await runEvidence(severity.claims, {
      sub: args.sub,
      username: args.participantUser,
      ...(args.participantThingId ? { thingId: args.participantThingId } : {}),
    });
  }

  let out;
  try {
    out = await generateReply({
      sub: args.sub,
      conversationId: args.conversationId,
      conversationSubject: args.conversationSubject,
      participantUser: args.participantUser,
      messages: args.turns,
      mode: args.mode,
      tonePrompt: args.tonePrompt,
      appUsername: args.appUsername,
      pmModsThreshold: args.settings.pmModsThreshold,
      ...(args.settings.generatedSignature ? { generatedSignature: args.settings.generatedSignature } : {}),
      ...(severity ? { severity } : {}),
      ...(evidence ? { evidence } : {}),
      ...(preflight ? { preflight } : {}),
      ...(karmaGate ? { karmaGate } : {}),
    });
  } catch (e) {
    if ((e as Error)?.message === 'REPLY_RETRY_EXHAUSTED') {
      result.reason = 'reply-generation-deferred';
      return result;
    }
    result.reason = `responder-failed:${(e as Error)?.message ?? 'err'}`;
    return result;
  }

  try {
    await waitMs(delayBeforeAction('modmail-reply', true));
    await withRateLimitRetry(
      () => args.api.reply({ conversationId: args.conversationId, body: out.body, isInternal: false }),
      { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
    );
  } catch (e) {
    result.reason = `reply-failed:${(e as Error)?.message ?? 'err'}`;
    return result;
  }

  result.replied = true;
  result.acted = true;
  await incrReplyCount(args.sub, args.conversationId);

  if (out.actions.flagForLivemod) {
    try {
      await waitMs(delayBeforeAction('modmail-highlight', true));
      await withRateLimitRetry(
        () => args.api.highlightConversation(args.conversationId),
        { actionType: 'modmail-highlight', sub: args.sub, thingId: args.conversationId },
      );
      result.flagged = true;
    } catch { /* best-effort */ }
  }
  if (out.actions.archive) {
    try {
      await waitMs(delayBeforeAction('modmail-archive', true));
      await withRateLimitRetry(
        () => args.api.archiveConversation(args.conversationId),
        { actionType: 'modmail-archive', sub: args.sub, thingId: args.conversationId },
      );
      result.archived = true;
    } catch { /* best-effort */ }
  }

  if (severity) {
    await maybePmMods({
      sub: args.sub,
      conversationId: args.conversationId,
      participantUser: args.participantUser,
      ...(args.participantThingId ? { thingId: args.participantThingId } : {}),
      threshold: args.settings.pmModsThreshold,
      severity,
      ...(evidence ? { evidence } : {}),
      bodyExcerpt: args.lastUserBody,
    });
  }

  if (args.settings.transcriptEnabled && remainingBudget(args.scanStartedAt) >= TRANSCRIPT_BUDGET_MIN_MS) {
    try {
      await generateAndStoreTranscript({
        sub: args.sub,
        conversationId: args.conversationId,
        conversationSubject: args.conversationSubject,
        participantUser: args.participantUser,
        conversation: args.apiTurns,
      });
    } catch (e) {
      console.warn('[amu/pipeline] transcript failed:', (e as Error)?.message);
    }
  }

  result.reason = 'replied';
  try {
    await postDetailedConvoReport({
      sub: args.sub,
      conversationId: args.conversationId,
      conversationSubject: args.conversationSubject,
      participantUser: args.participantUser,
      mode: args.mode,
      reason: result.reason,
      bodyExcerpt: args.lastUserBody,
      finalReply: out.body,
      userTurnCount,
      ...(severity ? { severity } : {}),
      ...(evidence ? { evidence } : {}),
      ...(preflight ? { preflight } : {}),
      actions: {
        markResolved: out.actions.markResolved,
        ...(out.actions.markResolvedReason ? { markResolvedReason: out.actions.markResolvedReason } : {}),
        flagForLivemod: out.actions.flagForLivemod,
        ...(out.actions.flagForLivemodReason ? { flagForLivemodReason: out.actions.flagForLivemodReason } : {}),
        archive: out.actions.archive,
        ...(out.actions.archiveReason ? { archiveReason: out.actions.archiveReason } : {}),
      },
    });
  } catch (e) {
    console.warn('[amu/pipeline] detailed report failed:', (e as Error)?.message);
  }
  return result;
}
