// SPDX-License-Identifier: GPL-3.0-only
// Periodic scan: replies to fresh non-mod inbound messages, sends a stale
// nudge after `staleHours`, auto-archives after `autoResolveAfterHours`.

import { reddit } from '@devvit/web/server';
import {
  AUTOMAIL_SCAN_CONVO_CAP,
  type AutoMailReplyMode,
  type AutoMailScanResult,
  type AutoMailScanState,
} from '../../shared/automail';
import { delayBeforeAction, withRateLimitRetry, waitMs, withTimeout } from './actionPacing';
import { generateReply, parseUserShortcut, type ResponderTurn } from './automailResponder';
import { ensureTonePrompt } from './automailTone';
import {
  acquireScanLock,
  claimSeenMessage,
  getConvoState,
  getSettings,
  releaseScanLock,
  saveSettings,
  setConvoState,
} from './automailStore';
import { getAppUsernameCached } from './appIdentity';
import { processOneConvo, SCAN_SOFT_DEADLINE_MS } from './convoPipeline';
import { extractDraftCandidateFromText } from './draftExtraction';
import { postInternalUserRepNote } from './modPm';
import type { ResponderConversationTurn } from '../ai-public/genaiClient';

type ModMailApi = typeof reddit.modMail;
type ModMailConvo = Awaited<ReturnType<ModMailApi['getConversations']>>['conversations'][string];
type ModMailMessage = ModMailConvo['messages'][string];

type ModMailMessageWithInternal = ModMailMessage & { isInternal?: boolean };

export interface MmConvo {
  id?: ModMailConvo['id'];
  subject?: ModMailConvo['subject'];
  state?: ModMailConvo['state'];
  numMessages?: ModMailConvo['numMessages'];
  lastUpdated?: ModMailConvo['lastUpdated'];
  participant?: ModMailConvo['participant'];
  authors?: ModMailConvo['authors'];
  messages?: ModMailConvo['messages'];
}

const api = (): ModMailApi => reddit.modMail;

function parseDateMs(d: string | undefined): number {
  if (!d) return 0;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : 0;
}

function orderedMessages(convo: MmConvo): ModMailMessage[] {
  const all = Object.values(convo.messages ?? {});
  return all.sort((a, b) => parseDateMs(a.date) - parseDateMs(b.date));
}

function isInternalModNote(message: ModMailMessage | undefined): boolean {
  if (!message) return false;
  if (!message.author?.isMod) return false;
  return Boolean((message as ModMailMessageWithInternal).isInternal);
}

function hasHumanModeratorParticipant(messages: ModMailMessage[], appUsername: string): boolean {
  const app = appUsername.toLowerCase();
  return messages.some((message) => {
    if (!message.author?.isMod) return false;
    const author = (message.author?.name ?? '').toLowerCase();
    return author.length > 0 && author !== app;
  });
}

function pickParticipant(convo: MmConvo): string | null {
  const name = convo.participant?.name;
  if (name) return name;
  const author = (convo.authors ?? []).find((a) => !a.isMod);
  return author?.name ?? null;
}

async function buildResponderTurns(convo: MmConvo, appUsername: string): Promise<ResponderTurn[]> {
  const out: ResponderTurn[] = [];
  for (const m of orderedMessages(convo)) {
    const author = (m.author?.name ?? '').toLowerCase();
    const isMod = Boolean(m.author?.isMod);
    const role: ResponderTurn['role'] = isMod
      ? (author === appUsername.toLowerCase() ? 'ai' : 'mod')
      : 'user';
    out.push({
      role,
      author: m.author?.name ?? 'unknown',
      body: m.bodyMarkdown ?? m.body ?? '',
      ts: parseDateMs(m.date),
    });
  }
  return out;
}

function turnsToApi(turns: ResponderTurn[]): ResponderConversationTurn[] {
  return turns.slice(-10).map((m) => {
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

export type ScanDecision =
  | { kind: 'reply'; mode: 'continue' }
  | { kind: 'reply'; mode: 'stale-nudge' }
  | { kind: 'auto-archive' }
  | { kind: 'skip'; reason: string };

export function decideForConvo(args: {
  convo: MmConvo;
  appUsername: string;
  staleHours: number;
  autoResolveAfterHours: number;
  awaitingResolutionDeadline: number | null;
  lastAiRepliedToMessageId: string | null;
  now: number;
}): ScanDecision {
  const { convo, appUsername, staleHours, awaitingResolutionDeadline, lastAiRepliedToMessageId, now } = args;
  const messages = orderedMessages(convo);
  if (messages.length === 0) return { kind: 'skip', reason: 'empty' };
  const last = messages[messages.length - 1];
  if (!last) return { kind: 'skip', reason: 'no-last' };

  const lastAuthor = (last.author?.name ?? '').toLowerCase();
  const lastIsMod = Boolean(last.author?.isMod);
  const lastIsApp = lastAuthor === appUsername.toLowerCase();
  const lastTs = parseDateMs(last.date);

  if (hasHumanModeratorParticipant(messages, appUsername)) {
    return { kind: 'skip', reason: 'human-mod-present' };
  }

  if (awaitingResolutionDeadline && now >= awaitingResolutionDeadline) {
    const userRepliedAfterDeadline = messages.some((m) => {
      const authorLower = (m.author?.name ?? '').toLowerCase();
      return !m.author?.isMod && authorLower !== appUsername.toLowerCase()
        && parseDateMs(m.date) >= (awaitingResolutionDeadline - 1);
    });
    if (!userRepliedAfterDeadline) return { kind: 'auto-archive' };
  }

  if (lastIsMod && !lastIsApp) {
    return { kind: 'skip', reason: 'human-mod-replied-last' };
  }

  if (!lastIsMod) {
    if (last.id && last.id === lastAiRepliedToMessageId) {
      return { kind: 'skip', reason: 'already-replied-to-this-message' };
    }
    return { kind: 'reply', mode: 'continue' };
  }

  if (lastIsApp) {
    const ageHours = (now - lastTs) / 3_600_000;
    if (!awaitingResolutionDeadline && ageHours >= staleHours) {
      return { kind: 'reply', mode: 'stale-nudge' };
    }
  }

  return { kind: 'skip', reason: 'no-action' };
}

export async function runScan(sub: string): Promise<AutoMailScanResult> {
  const startedAt = Date.now();
  const result: AutoMailScanResult = {
    startedAt,
    completedAt: 0,
    scanned: 0,
    replied: 0,
    staleNudged: 0,
    autoArchived: 0,
    skipped: 0,
    errors: 0,
    notes: [],
  };

  const settings = await getSettings(sub);
  const scanStates = settings.respondToStates.filter((state) => state !== 'mod');
  if (!settings.enabled) {
    result.notes.push('disabled');
    result.completedAt = Date.now();
    return result;
  }
  if (scanStates.length === 0) {
    result.notes.push('no-states-selected');
    result.completedAt = Date.now();
    return result;
  }

  const locked = await acquireScanLock(sub);
  if (!locked) {
    result.notes.push('scan-already-running');
    result.completedAt = Date.now();
    return result;
  }

  try {
    const tonePrompt = await ensureTonePrompt(sub);
    const appUsername = await getAppUsernameCached().catch(() => '');

    for (const state of scanStates) {
      if (result.scanned >= AUTOMAIL_SCAN_CONVO_CAP) break;
      if (Date.now() - startedAt > SCAN_SOFT_DEADLINE_MS) {
        result.notes.push('soft-deadline');
        break;
      }
      let page: Awaited<ReturnType<ModMailApi['getConversations']>>;
      try {
        page = await withRateLimitRetry(
          () => withTimeout(
            () => api().getConversations({ state, limit: 25 }),
            4000,
            { actionType: 'reddit-read', sub, thingId: null },
          ),
          { actionType: 'reddit-read', sub, thingId: null },
        );
      } catch (e) {
        result.errors++;
        result.notes.push(`getConversations(${state}) failed: ${(e as Error)?.message ?? 'err'}`);
        continue;
      }
      for (const id of page.conversationIds) {
        if (result.scanned >= AUTOMAIL_SCAN_CONVO_CAP) break;
        if (Date.now() - startedAt > SCAN_SOFT_DEADLINE_MS) {
          result.notes.push('soft-deadline');
          break;
        }
        result.scanned++;
        const convo = page.conversations[id];
        if (!convo) { result.skipped++; continue; }

        try {
          const convoState = await getConvoState(sub, id);
          const decision = decideForConvo({
            convo,
            appUsername,
            staleHours: settings.staleHours,
            autoResolveAfterHours: settings.autoResolveAfterHours,
            awaitingResolutionDeadline: convoState?.awaitingResolutionDeadline ?? null,
            lastAiRepliedToMessageId: convoState?.lastAiReplyAt ?? null,
            now: Date.now(),
          });

          if (decision.kind === 'skip') { result.skipped++; continue; }

          if (decision.kind === 'auto-archive') {
            await waitMs(delayBeforeAction('modmail-archive', false));
            await withRateLimitRetry(() => api().archiveConversation(id), { actionType: 'modmail-archive', sub, thingId: id });
            await setConvoState(sub, {
              conversationId: id,
              lastAiReplyAt: convoState?.lastAiReplyAt ?? null,
              awaitingResolutionDeadline: null,
              livemodFlagged: convoState?.livemodFlagged ?? false,
              resolvedByAi: true,
              updatedAt: Date.now(),
            });
            result.autoArchived++;
            continue;
          }

          const participant = pickParticipant(convo);
          if (!participant) { result.skipped++; continue; }
          const turns = await buildResponderTurns(convo, appUsername);
          const last = orderedMessages(convo).at(-1);

          if (decision.mode === 'continue' && last?.id) {
            const claimed = await claimSeenMessage(sub, last.id);
            if (!claimed) { result.skipped++; continue; }
          }

          const lastUserBody = last?.bodyMarkdown ?? last?.body ?? '';
          const pipeRes = await processOneConvo({
            sub,
            conversationId: id,
            conversationSubject: convo.subject ?? '(no subject)',
            participantUser: participant,
            lastMessageId: last?.id ?? null,
            lastUserBody,
            mode: decision.mode satisfies AutoMailReplyMode,
            state,
            turns,
            apiTurns: turnsToApi(turns),
            tonePrompt,
            appUsername,
            settings,
            api: {
              reply: (p) => api().reply(p),
              archiveConversation: (i) => api().archiveConversation(i),
              highlightConversation: (i) => api().highlightConversation(i),
            },
            scanStartedAt: startedAt,
            draftCandidate: extractDraftCandidateFromText(lastUserBody),
            draftPreflightSource: 'modmail',
          });

          if (!pipeRes.acted) {
            result.skipped++;
            if (pipeRes.reason) result.notes.push(`${id}: ${pipeRes.reason}`);
            continue;
          }

          const nextState = {
            conversationId: id,
            lastAiReplyAt: last?.id ?? convoState?.lastAiReplyAt ?? null,
            awaitingResolutionDeadline: decision.mode === 'stale-nudge'
              ? Date.now() + settings.autoResolveAfterHours * 3_600_000
              : null,
            livemodFlagged: pipeRes.flagged || (convoState?.livemodFlagged ?? false),
            resolvedByAi: pipeRes.archived || (convoState?.resolvedByAi ?? false),
            updatedAt: Date.now(),
          };
          await setConvoState(sub, nextState);

          if (decision.mode === 'stale-nudge') result.staleNudged++;
          else if (pipeRes.replied) result.replied++;
        } catch (e) {
          result.errors++;
          result.notes.push(`convo ${id}: ${(e as Error)?.message ?? 'err'}`);
        }
      }
    }

    await saveSettings(sub, { ...settings, lastScanAt: Date.now() });
  } finally {
    await releaseScanLock(sub);
  }

  result.completedAt = Date.now();
  return result;
}

export async function processInboundModmail(args: {
  sub: string;
  conversationId: string;
  isAutoGenerated?: boolean;
}): Promise<{ acted: boolean; reason: string }> {
  const startedAt = Date.now();
  const { sub, conversationId, isAutoGenerated } = args;
  if (isAutoGenerated) return { acted: false, reason: 'auto-generated' };

  const settings = await getSettings(sub);
  if (!settings.enabled) return { acted: false, reason: 'disabled' };

  const tonePrompt = await ensureTonePrompt(sub).catch(() => '');
  if (!tonePrompt) return { acted: false, reason: 'no-tone-prompt' };

  let convo: MmConvo | undefined;
  try {
    const got = await withRateLimitRetry(
      () => withTimeout(
        () => api().getConversation({ conversationId, markRead: false }),
        4000,
        { actionType: 'reddit-read', sub, thingId: conversationId },
      ),
      { actionType: 'reddit-read', sub, thingId: conversationId },
    );
    convo = got.conversation;
  } catch (e) {
    return { acted: false, reason: `getConversation failed: ${(e as Error)?.message ?? 'err'}` };
  }
  if (!convo) return { acted: false, reason: 'no-convo' };

  const appUsername = await getAppUsernameCached().catch(() => '');
  const messages = orderedMessages(convo);
  const last = messages[messages.length - 1];
  if (!last) return { acted: false, reason: 'no-messages' };

  const lastAuthor = (last.author?.name ?? '').toLowerCase();
  const lastIsApp = lastAuthor === appUsername.toLowerCase();
  if (lastIsApp) return { acted: false, reason: 'last-was-app' };

  const lastBody = last.bodyMarkdown ?? last.body ?? '';
  const lastIsMod = Boolean(last.author?.isMod);
  const hasHumanMod = hasHumanModeratorParticipant(messages, appUsername);

  if (lastIsMod) {
    if (last.id) {
      const claimed = await claimSeenMessage(sub, last.id);
      if (!claimed) return { acted: false, reason: 'already-seen' };
    }
    if (!isInternalModNote(last)) return { acted: false, reason: 'mod-msg-not-internal-note' };
    const shortcut = parseUserShortcut(lastBody);
    if (!shortcut) return { acted: false, reason: 'mod-msg-no-shortcut' };

    const participant = pickParticipant(convo);
    if (!participant) return { acted: false, reason: 'no-participant' };

    if (shortcut === 'rep') {
      const rep = await postInternalUserRepNote({
        sub,
        conversationId,
        participantUser: participant,
      });
      return { acted: rep.posted, reason: rep.posted ? 'shortcut-rep' : `shortcut-rep-failed:${rep.reason}` };
    }

    const turns = await buildResponderTurns(convo, appUsername);
    const mode: AutoMailReplyMode = 'archive-ack';

    try {
      const out = await generateReply({
        sub,
        conversationId,
        conversationSubject: convo.subject ?? '(no subject)',
        participantUser: participant,
        messages: turns,
        mode,
        tonePrompt,
        appUsername,
        ...(settings.generatedSignature ? { generatedSignature: settings.generatedSignature } : {}),
      });
      await waitMs(delayBeforeAction('modmail-reply', true));
      await withRateLimitRetry(() => api().reply({
        conversationId,
        body: out.body,
        isInternal: false,
      }), { actionType: 'modmail-reply', sub, thingId: conversationId });
    } catch (e) {
      return { acted: false, reason: `ack reply failed: ${(e as Error)?.message ?? 'err'}` };
    }

    try {
      await waitMs(delayBeforeAction('modmail-archive', false));
      await withRateLimitRetry(() => api().archiveConversation(conversationId), { actionType: 'modmail-archive', sub, thingId: conversationId });
    } catch { /* best-effort */ }

    const prev = await getConvoState(sub, conversationId);
    await setConvoState(sub, {
      conversationId,
      lastAiReplyAt: prev?.lastAiReplyAt ?? null,
      awaitingResolutionDeadline: null,
      livemodFlagged: prev?.livemodFlagged ?? false,
      resolvedByAi: true,
      updatedAt: Date.now(),
    });
    return { acted: true, reason: 'shortcut-archive' };
  }

  if (hasHumanMod) return { acted: false, reason: 'human-mod-present' };

  const lcState = (convo.state ?? '').toLowerCase() as AutoMailScanState;
  if (!settings.respondToStates.includes(lcState)) {
    return { acted: false, reason: `state-${lcState}-not-targeted` };
  }
  if (last.id) {
    const claimed = await claimSeenMessage(sub, last.id);
    if (!claimed) return { acted: false, reason: 'already-seen' };
  }

  const participant = pickParticipant(convo);
  if (!participant) return { acted: false, reason: 'no-participant' };
  const turns = await buildResponderTurns(convo, appUsername);

  const pipeRes = await processOneConvo({
    sub,
    conversationId,
    conversationSubject: convo.subject ?? '(no subject)',
    participantUser: participant,
    lastMessageId: last.id ?? null,
    lastUserBody: lastBody,
    mode: 'continue',
    state: lcState,
    turns,
    apiTurns: turnsToApi(turns),
    tonePrompt,
    appUsername,
    settings,
    api: {
      reply: (p) => api().reply(p),
      archiveConversation: (i) => api().archiveConversation(i),
      highlightConversation: (i) => api().highlightConversation(i),
    },
    scanStartedAt: startedAt,
    draftCandidate: extractDraftCandidateFromText(lastBody),
    draftPreflightSource: 'modmail',
  });

  if (!pipeRes.acted) return { acted: false, reason: pipeRes.reason || 'pipeline-noop' };

  const prev = await getConvoState(sub, conversationId);
  await setConvoState(sub, {
    conversationId,
    lastAiReplyAt: last.id ?? null,
    awaitingResolutionDeadline: null,
    livemodFlagged: pipeRes.flagged || (prev?.livemodFlagged ?? false),
    resolvedByAi: pipeRes.archived || (prev?.resolvedByAi ?? false),
    updatedAt: Date.now(),
  });
  return { acted: true, reason: pipeRes.reason };
}

export const __testables = { decideForConvo, parseDateMs, orderedMessages };
