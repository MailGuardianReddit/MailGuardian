// SPDX-License-Identifier: GPL-3.0-only
// Transcript runner: post-cycle, mod-only English transcript generator.
// Fail-closed: any error => skip silently, do not retry inside the same
// scan cycle.

import { buildTranscriptSystemInstruction, callTranscript } from '@ai';
import type { ResponderConversationTurn } from '../ai-public/genaiClient';
import { resolveAiKey } from './aiRuntime';
import { reddit } from '@devvit/web/server';
import { delayBeforeAction, waitMs, withRateLimitRetry, withTimeout } from './actionPacing';
import { claimTranscriptSent, getTranscript, releaseTranscriptSent, setTranscript } from './automailStore';

const TRANSCRIPT_TIMEOUT_MS = 6000;
const TRANSCRIPT_BODY_MAX = 9_800;

function replyApi(): typeof reddit.modMail {
  return reddit.modMail;
}

function asciiSafe(s: string): string {
  return s
    .replace(/[\u2014\u2013]/g, '--')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E\n\t]/g, '?');
}

export type TranscriptArgs = {
  sub: string;
  conversationId: string;
  conversationSubject: string;
  participantUser: string;
  conversation: ResponderConversationTurn[];
};

export async function generateAndStoreTranscript(args: TranscriptArgs): Promise<{ ok: boolean; reason: string }> {
  const existing = await getTranscript(args.sub, args.conversationId).catch(() => null);
  if (existing && existing.trim().length > 0) return { ok: true, reason: 'already-posted' };
  const claimed = await claimTranscriptSent(args.sub, args.conversationId);
  if (!claimed) return { ok: true, reason: 'already-posted' };

  let key;
  try {
    key = await resolveAiKey(args.sub);
  } catch {
    await releaseTranscriptSent(args.sub, args.conversationId);
    return { ok: false, reason: 'key-resolve-failed' };
  }
  if (!key.ok) {
    await releaseTranscriptSent(args.sub, args.conversationId);
    return { ok: false, reason: `no-key:${key.error}` };
  }
  const apiKey = key.apiKey;

  const system = buildTranscriptSystemInstruction({ sub: args.sub });

  await waitMs(delayBeforeAction('ai-transcript', true));
  try {
    const out = await withTimeout(
      () => withRateLimitRetry(
        () => callTranscript({
          apiKey,
          system,
          conversationSubject: args.conversationSubject,
          conversation: args.conversation,
        }),
        { actionType: 'ai-transcript', sub: args.sub, thingId: args.conversationId },
      ),
      TRANSCRIPT_TIMEOUT_MS,
      { actionType: 'ai-transcript', sub: args.sub, thingId: args.conversationId },
    );
    const text = (out.englishTranscript ?? '').trim();
    if (!text) {
      await releaseTranscriptSent(args.sub, args.conversationId);
      return { ok: false, reason: 'empty' };
    }
    const safeTranscript = asciiSafe(text).slice(0, TRANSCRIPT_BODY_MAX);
    const noteLines: string[] = [];
    noteLines.push('[MG Transcript] mod-only -- do not share outside the mod team');
    noteLines.push('');
    noteLines.push(`Conversation: ${args.conversationId}`);
    noteLines.push(`OP: u/${args.participantUser}`);
    noteLines.push(`Generated: ${new Date().toISOString()}`);
    noteLines.push('');
    noteLines.push('--- ENGLISH TRANSCRIPT ---');
    noteLines.push(safeTranscript);
    noteLines.push('');
    noteLines.push(`Detected languages: ${out.detectedLanguages.join(', ') || 'unknown'}`);
    const noteBody = noteLines.join('\n');
    const modMail = replyApi();
    if (modMail.reply) {
      await waitMs(delayBeforeAction('modmail-reply', false));
      await withTimeout(
        () => withRateLimitRetry(
          () => modMail.reply({ conversationId: args.conversationId, body: noteBody, isInternal: true, isAuthorHidden: true }),
          { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
        ),
        TRANSCRIPT_TIMEOUT_MS,
        { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
      );
    }
    await setTranscript(args.sub, args.conversationId, safeTranscript);
    return { ok: true, reason: 'posted' };
  } catch (e) {
    await releaseTranscriptSent(args.sub, args.conversationId);
    return { ok: false, reason: `failed:${(e as Error)?.message ?? 'err'}` };
  }
}
