// SPDX-License-Identifier: GPL-3.0-only
// Mod PM delivery. PM bodies are structured ASCII markdown
// (no em dashes, no AI tells). Idempotent via amu:pm:sent fingerprint.
//
// Devvit symbols here are reached through narrow `unknown` casts:
//   reddit.modMail.createConversation
// Both need MCP confirmation; their shapes are documented in the
// "Unverified API surfaces" handoff.

import { createHash } from 'node:crypto';
import { reddit } from '@devvit/web/server';
import {
  type AutoMailReplyMode,
  type DraftPreflightContext,
  pmThresholdAllowsLevel,
  type EvidenceBundle,
  type PmThreshold,
  type SeverityResult,
} from '../../shared/automail';
import { delayBeforeAction, waitMs, withRateLimitRetry, withTimeout } from './actionPacing';
import {
  claimDetailedReportRevision,
  claimDetailedReportSent,
  claimPmFingerprint,
  getDetailedReportSnapshot,
  releasePmFingerprint,
  releaseDetailedReportRevision,
  releaseDetailedReportSent,
  setDetailedReportSnapshot,
  type DetailedConvoReportSnapshot,
} from './automailStore';
import {
  fetchAccuserComments,
  analyzeAccuserCommentPatterns,
  fetchUserRepSnapshot,
  type AccuserComment,
} from './evidence';

const PM_TIMEOUT_MS = 4000;
const PM_BODY_EXCERPT_MAX = 280;

const SEVERITY_LEVEL_LABEL: Record<number, string> = {
  1: 'ROUTINE',
  2: 'MODERATE',
  3: 'ELEVATED',
  4: 'HIGH',
  5: 'CRITICAL',
};

function pmApi(): typeof reddit.modMail {
  return reddit.modMail;
}

function severityFingerprint(severity: SeverityResult): string {
  const cats = [...severity.categories].sort().join(',');
  const h = createHash('sha1').update(`${severity.level}|${cats}`).digest('hex');
  return h.slice(0, 12);
}

function asciiSafe(s: string): string {
  return s
    .replace(/[\u2014\u2013]/g, '--')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E\n\t]/g, '?');
}

function clipExcerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= PM_BODY_EXCERPT_MAX) return asciiSafe(flat);
  return asciiSafe(flat.slice(0, PM_BODY_EXCERPT_MAX - 3)) + '...';
}

export type MaybePmModsArgs = {
  sub: string;
  conversationId: string;
  participantUser: string;
  thingId?: string;
  threshold: PmThreshold;
  severity: SeverityResult;
  evidence?: EvidenceBundle;
  bodyExcerpt: string;
  urgency?: boolean;
};

export type DetailedConvoReportArgs = {
  sub: string;
  conversationId: string;
  conversationSubject: string;
  participantUser: string;
  mode: AutoMailReplyMode;
  reason: string;
  bodyExcerpt: string;
  finalReply?: string;
  userTurnCount?: number;
  severity?: SeverityResult;
  evidence?: EvidenceBundle;
  preflight?: DraftPreflightContext;
  actions?: {
    markResolved?: boolean;
    markResolvedReason?: string;
    flagForLivemod?: boolean;
    flagForLivemodReason?: string;
    archive?: boolean;
    archiveReason?: string;
  };
};

function normalizeUser(name: string): string {
  const raw = asciiSafe(name).trim();
  if (!raw) return '';
  return raw.toLowerCase().startsWith('u/') ? raw : `u/${raw}`;
}

function collectInvolvedUsers(args: MaybePmModsArgs): string[] {
  const users = new Set<string>();
  users.add(normalizeUser(args.participantUser));

  const items = args.evidence?.items ?? [];
  for (const it of items) {
    const data = (it.data && typeof it.data === 'object') ? (it.data as Record<string, unknown>) : null;
    const raw = data?.['nearbyLikelyAbusers'];
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const base = entry.replace(/\(\d+\)$/, '');
      const user = normalizeUser(base);
      if (user) users.add(user);
    }
  }
  return [...users].filter((u) => u.length > 0);
}

function userLink(name: string): string {
  const normalized = normalizeUser(name);
  if (!normalized) return '';
  return `[${normalized}](https://reddit.com/${normalized})`;
}

function relatedThingLink(thingId?: string): string | null {
  if (!thingId) return null;
  if (thingId.startsWith('t3_')) {
    const id36 = thingId.slice(3);
    return id36 ? `[view post](https://www.reddit.com/comments/${id36})` : null;
  }
  if (thingId.startsWith('t1_')) {
    return `[view comment](https://www.reddit.com/by_id/${thingId})`;
  }
  return null;
}

function collectHarassmentSnippets(args: MaybePmModsArgs): string[] {
  const snippets: string[] = [];
  const items = args.evidence?.items ?? [];
  for (const it of items) {
    if (it.kind !== 'harassed_by_user') continue;
    const data = (it.data && typeof it.data === 'object') ? (it.data as Record<string, unknown>) : null;
    const raw = data?.['nearbyHostileSnippets'];
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const cleaned = asciiSafe(entry).slice(0, 220);
      if (cleaned.length > 0) snippets.push(cleaned);
    }
  }
  return snippets.slice(0, 5);
}

function getAccuserList(args: MaybePmModsArgs): string[] {
  const items = args.evidence?.items ?? [];
  for (const it of items) {
    if (it.kind !== 'harassed_by_user') continue;
    const data = (it.data && typeof it.data === 'object') ? (it.data as Record<string, unknown>) : null;
    const raw = data?.['nearbyLikelyAbusers'];
    if (Array.isArray(raw)) {
      return raw
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.replace(/\(\d+\)$/, ''))
        .filter((entry) => entry.length > 0)
        .slice(0, 5);
    }
  }
  return [];
}

async function collectAccuserComments(args: MaybePmModsArgs): Promise<AccuserComment[]> {
  const accusers = getAccuserList(args);
  if (accusers.length === 0) return [];
  try {
    return await fetchAccuserComments(accusers, args.sub, 8);
  } catch {
    return [];
  }
}

type UserProfileSnapshot = {
  profileAccountAgeDays: number;
  profileLinkKarma: number;
  profileCommentKarma: number;
  profileSubKarmaPost: number;
  profileSubKarmaComment: number;
  profileModNoteCount: number;
  profileModNoteSummary: string;
  profileShadowbanned: boolean;
  profileNsfw: boolean;
};

function collectUserProfile(args: MaybePmModsArgs): UserProfileSnapshot | null {
  const items = args.evidence?.items ?? [];
  for (const it of items) {
    if (it.kind !== 'harassed_by_user' && it.kind !== 'ban_unfair') continue;
    const d = (it.data && typeof it.data === 'object') ? (it.data as Record<string, unknown>) : null;
    if (!d || typeof d['profileAccountAgeDays'] !== 'number') continue;
    return {
      profileAccountAgeDays: d['profileAccountAgeDays'] as number,
      profileLinkKarma: typeof d['profileLinkKarma'] === 'number' ? (d['profileLinkKarma'] as number) : 0,
      profileCommentKarma: typeof d['profileCommentKarma'] === 'number' ? (d['profileCommentKarma'] as number) : 0,
      profileSubKarmaPost: typeof d['profileSubKarmaPost'] === 'number' ? (d['profileSubKarmaPost'] as number) : 0,
      profileSubKarmaComment: typeof d['profileSubKarmaComment'] === 'number' ? (d['profileSubKarmaComment'] as number) : 0,
      profileModNoteCount: typeof d['profileModNoteCount'] === 'number' ? (d['profileModNoteCount'] as number) : 0,
      profileModNoteSummary: typeof d['profileModNoteSummary'] === 'string' ? (d['profileModNoteSummary'] as string) : '',
      profileShadowbanned: d['profileShadowbanned'] === true,
      profileNsfw: d['profileNsfw'] === true,
    };
  }
  return null;
}

function formatAccuserCommentLine(comment: AccuserComment, includeSubreddit: boolean): string {
  const dateStr = comment.createdAtIso.slice(0, 10);
  const subredditPart = includeSubreddit ? ` in r/${asciiSafe(comment.subreddit)}` : '';
  return `> ${userLink(comment.author)} on ${dateStr}${subredditPart}: ${asciiSafe(comment.body).slice(0, 200)}`;
}

function formatHostileCountsByAuthor(pattern: NonNullable<Awaited<ReturnType<typeof analyzeAccuserCommentPatterns>>>): string {
  return pattern.hostileByAuthor
    .map((entry) => {
      const parts: string[] = [];
      if (entry.currentSubHostileComments > 0) parts.push(`${entry.currentSubHostileComments} current`);
      if (entry.outsideCurrentSubHostileComments > 0) parts.push(`${entry.outsideCurrentSubHostileComments} outside`);
      const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      return `${userLink(entry.author)} ${entry.hostileComments}${detail}`;
    })
    .join('; ');
}

async function buildEscalationNoteFromAccuserComments(
  args: MaybePmModsArgs,
  accuserComments: AccuserComment[],
): Promise<string> {
  const label = SEVERITY_LEVEL_LABEL[args.severity.level] ?? String(args.severity.level);
  const users = collectInvolvedUsers(args);
  const thingLink = relatedThingLink(args.thingId);
  const harassmentSnippets = collectHarassmentSnippets(args);
  const evLines = (args.evidence?.items ?? [])
    .filter((it) => it.summary)
    .map((it) => `- ${it.kind} (${it.ok ? 'ok' : 'fail'}): ${asciiSafe(it.summary)}`);
  const profile = collectUserProfile(args);
  const currentSubHostileAccuserComments = accuserComments.filter((c) => c.hostilityScore > 0 && c.subreddit.toLowerCase() === args.sub.toLowerCase());
  const pattern = await analyzeAccuserCommentPatterns(accuserComments, args.sub);

  const lines: string[] = [];
  lines.push('## [MG] Escalation');
  lines.push('');
  lines.push(`**Reason:** ${asciiSafe(args.severity.rationale).slice(0, 200)}`);
  lines.push(`**Confidence:** ${args.severity.level}/5 (${label})`);
  lines.push(`**Sources:** ${args.severity.categories.join(', ')} | claims: ${args.severity.claims.join(', ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**Users involved:** ${users.map(userLink).join(', ')}`);
  if (thingLink) lines.push(`**Related post/comment:** ${thingLink}`);
  if (evLines.length > 0) {
    lines.push('');
    lines.push('### Evidence summary');
    lines.push('');
    for (const e of evLines) lines.push(e);
  }
  if (harassmentSnippets.length > 0) {
    lines.push('');
    lines.push('### Evidence snippets');
    lines.push('');
    for (const s of harassmentSnippets) lines.push(`> ${s}`);
  }
  if (currentSubHostileAccuserComments.length > 0) {
    lines.push('');
    lines.push('### Current-sub accuser hostile comments');
    lines.push('');
    for (const c of currentSubHostileAccuserComments.slice(0, 3)) {
      lines.push(formatAccuserCommentLine(c, false));
    }
  }
  if (pattern) {
    lines.push('');
    lines.push('### Accuser pattern analysis');
    lines.push('');
    lines.push(`- **Hostile comments found:** ${pattern.hostileComments}/${pattern.totalComments}`);
    lines.push(`- **Distinct accusers with hostile history:** ${pattern.distinctAuthors}`);
    lines.push(`- **In this subreddit:** ${pattern.currentSubHostileComments}/${pattern.hostileComments}`);
    lines.push(`- **Outside this subreddit:** ${pattern.outsideCurrentSubHostileComments}/${pattern.hostileComments}`);
    if (pattern.hostileByAuthor.length > 0) {
      lines.push(`- **Hostile counts by author:** ${formatHostileCountsByAuthor(pattern)}`);
    }
    for (const category of pattern.categoryLabels) {
      lines.push(`- **Pattern detected:** ${category}`);
    }
    if (pattern.topThemes.length > 0) lines.push(`- **Common themes:** ${pattern.topThemes.join(', ')}`);
  }
  if ((pattern?.outsideCurrentSubExamples.length ?? 0) > 0) {
    lines.push('');
    lines.push(`### Prior hostility outside r/${asciiSafe(args.sub)}`);
    lines.push('');
    for (const c of pattern?.outsideCurrentSubExamples ?? []) {
      lines.push(formatAccuserCommentLine(c, true));
    }
  }
  if (profile) {
    lines.push('');
    lines.push('### User profile');
    lines.push('');
    lines.push(`- **Account age:** ${profile.profileAccountAgeDays} days`);
    lines.push(`- **Sitewide karma:** link=${profile.profileLinkKarma} comment=${profile.profileCommentKarma}`);
    lines.push(`- **Sub karma:** post=${profile.profileSubKarmaPost} comment=${profile.profileSubKarmaComment}`);
    if (profile.profileModNoteCount > 0) {
      const noteSuffix = profile.profileModNoteSummary ? ` -- ${asciiSafe(profile.profileModNoteSummary)}` : '';
      lines.push(`- **Mod notes:** ${profile.profileModNoteCount}${noteSuffix}`);
    }
    if (profile.profileShadowbanned) lines.push('- **Shadowbanned:** yes');
    if (profile.profileNsfw) lines.push('- **NSFW profile:** yes');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`*PM sent to mod team (severity ${args.severity.level} >= threshold ${args.threshold}).*`);
  return lines.join('\n');
}

async function buildEscalationNote(args: MaybePmModsArgs): Promise<string> {
  const accuserComments = await collectAccuserComments(args);
  return buildEscalationNoteFromAccuserComments(args, accuserComments);
}

function extractCommentLinesFromSummary(summary: string): string[] {
  const lines = summary.split(/\r?\n/);
  const out: string[] = [];
  const commentSectionHeaders = new Set([
    'USER COMMENT HISTORY:',
    'THREAD CONTEXT COMMENTS:',
    'ACCUSER COMMENTS:',
  ]);
  let capture = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (capture) out.push('');
      continue;
    }
    if (commentSectionHeaders.has(line)) {
      capture = true;
      out.push(line);
      continue;
    }
    if (!capture) continue;
    if (/^\d+\.\s+/.test(line)) {
      out.push(line);
      continue;
    }
    if (line.endsWith(':')) {
      capture = false;
    }
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function extractImageLinesFromEvidence(evidence?: EvidenceBundle): string[] {
  if (!evidence || evidence.items.length === 0) return [];
  const out = new Set<string>();
  for (const item of evidence.items) {
    const source = `${item.summary}\n${typeof item.data === 'object' ? JSON.stringify(item.data) : ''}`;
    const matches = source.match(/https?:\/\/[^\s"']+/gi) ?? [];
    for (const url of matches) {
      if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(url) || /imgur|i\.redd\.it|reddit\.com/i.test(url)) {
        out.add(`- ${asciiSafe(url)}`);
      }
    }
  }
  return [...out];
}

function buildDetailedConversationReport(args: DetailedConvoReportArgs): string {
  const choiceLines = new Set<string>();
  if (args.actions?.markResolved === true) {
    const reason = asciiSafe(args.actions.markResolvedReason ?? 'responder selected mark_resolved');
    choiceLines.add(`- Mark Resolved - Reason: ${reason}`);
  }
  if (args.actions?.flagForLivemod === true) {
    const fallback = args.severity
      ? `severity level ${args.severity.level} requires moderator review`
      : 'needs human moderator review';
    const reason = asciiSafe(args.actions.flagForLivemodReason ?? fallback);
    choiceLines.add(`- Notified Moderator - Reason: ${reason}`);
  }
  if (args.actions?.archive === true) {
    const reason = asciiSafe(args.actions.archiveReason ?? 'archive action selected');
    choiceLines.add(`- Archived Conversation - Reason: ${reason}`);
  }

  const comments = args.severity?.userProfile?.userHistorySummary
    ? extractCommentLinesFromSummary(args.severity.userProfile.userHistorySummary)
    : [];
  const images = extractImageLinesFromEvidence(args.evidence);

  const lines: string[] = [];
  lines.push('# Scenario: detailed-mod-report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Severity output');
  if (args.severity) {
    lines.push(`- level: ${args.severity.level}`);
    lines.push(`- categories: ${args.severity.categories.join(', ') || 'none'}`);
    lines.push(`- claims: ${args.severity.claims.join(', ') || 'none'}`);
    lines.push(`- rationale: ${asciiSafe(args.severity.rationale) || 'none'}`);
  } else {
    lines.push('- level: (none)');
    lines.push('- categories: (none)');
    lines.push('- claims: (none)');
    lines.push(`- rationale: ${asciiSafe(args.reason) || 'none'}`);
  }

  lines.push('');
  lines.push('## Evidence summary');
  lines.push(`- comments: ${comments.filter((v) => /^\d+\.\s+/.test(v)).length}`);
  lines.push(`- images: ${images.length}`);
  lines.push(`- lookup=${args.evidence && args.evidence.items.length > 0 ? 'ran' : 'not-run-in-scenario-runner'}`);

  lines.push('');
  lines.push('## User concern summary');
  lines.push(asciiSafe(args.severity?.rationale || clipExcerpt(args.bodyExcerpt) || args.reason));

  lines.push('');
  lines.push('## Choices Made');
  if (choiceLines.size > 0) {
    for (const line of choiceLines) lines.push(line);
  } else {
    lines.push('- No explicit responder action flags were selected.');
  }

  lines.push('');
  lines.push('## Comments');
  lines.push(...(comments.length > 0 ? comments : ['(none)']));

  lines.push('');
  lines.push('## Images');
  lines.push(...(images.length > 0 ? images : ['(none)']));

  return lines.join('\n');
}

function buildDetailedConversationSnapshot(args: DetailedConvoReportArgs): DetailedConvoReportSnapshot {
  const choiceLines = new Set<string>();
  if (args.actions?.markResolved === true) {
    choiceLines.add(`mark_resolved:${asciiSafe(args.actions.markResolvedReason ?? 'responder selected mark_resolved')}`);
  }
  if (args.actions?.flagForLivemod === true) {
    const fallback = args.severity
      ? `severity level ${args.severity.level} requires moderator review`
      : 'needs human moderator review';
    choiceLines.add(`flag_for_livemod:${asciiSafe(args.actions.flagForLivemodReason ?? fallback)}`);
  }
  if (args.actions?.archive === true) {
    choiceLines.add(`archive:${asciiSafe(args.actions.archiveReason ?? 'archive action selected')}`);
  }
  const comments = args.severity?.userProfile?.userHistorySummary
    ? extractCommentLinesFromSummary(args.severity.userProfile.userHistorySummary)
    : [];
  const images = extractImageLinesFromEvidence(args.evidence);
  const evidenceKinds = [...new Set((args.evidence?.items ?? []).map((item) => `${item.kind}:${item.ok ? 'ok' : 'fail'}`))].sort();

  return {
    version: 1,
    concernSummary: asciiSafe(args.severity?.rationale || clipExcerpt(args.bodyExcerpt) || args.reason),
    severityLevel: args.severity?.level ?? null,
    categories: [...(args.severity?.categories ?? [])].sort(),
    claims: [...(args.severity?.claims ?? [])].sort(),
    evidenceKinds,
    imageCount: images.length,
    commentCount: comments.filter((line) => /^\d+\.\s+/.test(line)).length,
    choices: [...choiceLines].sort(),
  };
}

function summarizeDetailedReportChanges(
  prev: DetailedConvoReportSnapshot,
  next: DetailedConvoReportSnapshot,
): string[] {
  const changes: string[] = [];
  if (prev.severityLevel !== next.severityLevel) changes.push('severity changed');
  if (prev.categories.join('|') !== next.categories.join('|')) changes.push('categories changed');
  if (prev.claims.join('|') !== next.claims.join('|')) changes.push('claims changed');
  if (prev.evidenceKinds.join('|') !== next.evidenceKinds.join('|')) changes.push('evidence changed');
  if (prev.imageCount !== next.imageCount) changes.push('image signals changed');
  if (prev.commentCount !== next.commentCount) changes.push('comment context changed');
  if (prev.choices.join('|') !== next.choices.join('|')) changes.push('moderation choices changed');
  if (prev.concernSummary !== next.concernSummary) changes.push('concern summary changed');
  return changes;
}

function detailedReportSnapshotFingerprint(snapshot: DetailedConvoReportSnapshot): string {
  return createHash('sha1').update(JSON.stringify(snapshot)).digest('hex').slice(0, 12);
}

function buildSupersedingDetailedConversationReport(
  args: DetailedConvoReportArgs,
  prev: DetailedConvoReportSnapshot,
  next: DetailedConvoReportSnapshot,
  changes: string[],
): string {
  const lines: string[] = [];
  lines.push('# [MG] Updated internal summary');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Conversation: ${args.conversationId}`);
  lines.push(`OP: ${userLink(args.participantUser)}`);
  lines.push('');
  lines.push('This note supersedes the earlier MG internal summary because later conversation turns materially changed the situation.');
  lines.push('');
  lines.push(`- User turns seen: ${args.userTurnCount ?? 0}`);
  lines.push(`- Why updated: ${changes.join('; ')}`);
  lines.push('');
  lines.push('## Current summary');
  lines.push(`- concern: ${next.concernSummary || 'none'}`);
  lines.push(`- severity: ${next.severityLevel ?? '(none)'}`);
  lines.push(`- categories: ${next.categories.join(', ') || 'none'}`);
  lines.push(`- claims: ${next.claims.join(', ') || 'none'}`);
  lines.push(`- evidence: ${next.evidenceKinds.join(', ') || 'none'}`);
  lines.push(`- choices: ${next.choices.join(', ') || 'none'}`);
  lines.push('');
  lines.push('## Prior summary');
  lines.push(`- concern: ${prev.concernSummary || 'none'}`);
  lines.push(`- severity: ${prev.severityLevel ?? '(none)'}`);
  lines.push(`- categories: ${prev.categories.join(', ') || 'none'}`);
  lines.push(`- claims: ${prev.claims.join(', ') || 'none'}`);
  lines.push('');
  lines.push(`[Open in modmail](https://mod.reddit.com/mail/perma/${args.conversationId})`);
  return lines.join('\n');
}

export async function postDetailedConvoReport(args: DetailedConvoReportArgs): Promise<{ posted: boolean; reason: string }> {
  const modMail = pmApi();
  if (!modMail.reply) return { posted: false, reason: 'modmail-reply-unsupported' };
  const body = buildDetailedConversationReport(args);
  const snapshot = buildDetailedConversationSnapshot(args);
  const snapshotFingerprint = detailedReportSnapshotFingerprint(snapshot);
  const claimed = await claimDetailedReportSent(args.sub, args.conversationId);
  if (!claimed) {
    if ((args.userTurnCount ?? 0) <= 1) return { posted: false, reason: 'already-posted' };
    const prev = await getDetailedReportSnapshot(args.sub, args.conversationId);
    const changes = prev
      ? summarizeDetailedReportChanges(prev, snapshot)
      : ['baseline snapshot unavailable'];
    if (prev && changes.length === 0) return { posted: false, reason: 'no-material-change' };
    const claimedRevision = await claimDetailedReportRevision(args.sub, args.conversationId, snapshotFingerprint);
    if (!claimedRevision) return { posted: false, reason: 'revision-already-posted' };
    const supersedingBody = prev
      ? buildSupersedingDetailedConversationReport(args, prev, snapshot, changes)
      : buildSupersedingDetailedConversationReport(args, snapshot, snapshot, changes);
    await waitMs(delayBeforeAction('modmail-reply', false));
    try {
      await withTimeout(
        () => withRateLimitRetry(
          () => modMail.reply({ conversationId: args.conversationId, body: supersedingBody, isInternal: true, isAuthorHidden: true }),
          { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
        ),
        PM_TIMEOUT_MS,
        { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
      );
      await setDetailedReportSnapshot(args.sub, args.conversationId, snapshot);
      return { posted: true, reason: 'superseding-posted' };
    } catch (e) {
      await releaseDetailedReportRevision(args.sub, args.conversationId, snapshotFingerprint);
      return { posted: false, reason: `failed:${(e as Error)?.message ?? 'err'}` };
    }
  }
  await waitMs(delayBeforeAction('modmail-reply', false));
  try {
    await withTimeout(
      () => withRateLimitRetry(
        () => modMail.reply({ conversationId: args.conversationId, body, isInternal: true, isAuthorHidden: true }),
        { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
      ),
      PM_TIMEOUT_MS,
      { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
    );
    await setDetailedReportSnapshot(args.sub, args.conversationId, snapshot);
    return { posted: true, reason: 'posted' };
  } catch (e) {
    await releaseDetailedReportSent(args.sub, args.conversationId);
    return { posted: false, reason: `failed:${(e as Error)?.message ?? 'err'}` };
  }
}

export async function postInternalUserRepNote(args: {
  sub: string;
  conversationId: string;
  participantUser: string;
}): Promise<{ posted: boolean; reason: string }> {
  const modMail = pmApi();
  if (!modMail.reply) return { posted: false, reason: 'modmail-reply-unsupported' };

  const snapshot = await fetchUserRepSnapshot({
    sub: args.sub,
    username: args.participantUser,
    limit: 5,
  });

  const lines: string[] = [];
  lines.push('# [MG] User context report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Conversation: ${args.conversationId}`);
  lines.push(`User: ${userLink(args.participantUser)}`);

  if (snapshot.profile) {
    lines.push('');
    lines.push('## Profile');
    lines.push(`- Account age: ${snapshot.profile.accountAgeDays} days`);
    lines.push(`- Sitewide karma: link=${snapshot.profile.linkKarma}, comment=${snapshot.profile.commentKarma}`);
    lines.push(`- Sub karma: post=${snapshot.profile.subKarmaPost}, comment=${snapshot.profile.subKarmaComment}`);
    lines.push(`- Mod notes: ${snapshot.profile.modNoteCount}`);
    if (snapshot.profile.modNoteSummary) lines.push(`- Mod note summary: ${asciiSafe(snapshot.profile.modNoteSummary)}`);
    lines.push(`- Shadowbanned: ${snapshot.profile.shadowbanned ? 'yes' : 'no'}`);
    lines.push(`- NSFW profile: ${snapshot.profile.nsfw ? 'yes' : 'no'}`);
    lines.push(`- Verified email: ${snapshot.profile.hasVerifiedEmail ? 'yes' : 'no'}`);
  } else {
    lines.push('');
    lines.push('## Profile');
    lines.push('- Profile snapshot unavailable.');
  }

  lines.push('');
  lines.push('## Recent comments (latest 5)');
  if (snapshot.recentComments.length === 0) {
    lines.push('- No recent comments available.');
  } else {
    for (const comment of snapshot.recentComments) {
      const dateStr = comment.createdAtIso.slice(0, 10);
      lines.push(`- [${dateStr}] r/${asciiSafe(comment.subreddit)} score=${comment.score}: ${asciiSafe(comment.body)}`);
    }
  }

  lines.push('');
  lines.push(`[Open in modmail](https://mod.reddit.com/mail/perma/${args.conversationId})`);
  const body = lines.join('\n');

  await waitMs(delayBeforeAction('modmail-reply', false));
  try {
    await withTimeout(
      () => withRateLimitRetry(
        () => modMail.reply({
          conversationId: args.conversationId,
          body,
          isInternal: true,
          isAuthorHidden: true,
        }),
        { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
      ),
      PM_TIMEOUT_MS,
      { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
    );
    return { posted: true, reason: 'posted' };
  } catch (e) {
    return { posted: false, reason: `failed:${(e as Error)?.message ?? 'err'}` };
  }
}

export async function sendMemberScannerReportToMods(args: {
  sub: string;
  subredditId?: `t5_${string}`;
  targetUsername: string;
  scenarioId: string;
  scenarioLabel: string;
  scenarioPrompt: string;
  requestedBy?: string;
}): Promise<{ posted: boolean; reason: string; subject: string }> {
  const modMail = pmApi();
  if (!modMail.createConversation && !modMail.createModDiscussionConversation) {
    return {
      posted: false,
      reason: 'pm-unsupported',
      subject: `[MG] Member Scanner: u/${asciiSafe(args.targetUsername)}`,
    };
  }

  const normalizedUser = args.targetUsername.replace(/^u\//i, '').trim();
  const subject = `[MG] Member Scanner: u/${asciiSafe(normalizedUser)} (${asciiSafe(args.scenarioLabel)})`;
  console.log('[MG/member-scanner] start', {
    sub: args.sub,
    subredditId: args.subredditId ?? null,
    targetUsername: normalizedUser,
    scenarioId: args.scenarioId,
    requestedBy: args.requestedBy ?? null,
  });

  const snapshot = await fetchUserRepSnapshot({
    sub: args.sub,
    username: normalizedUser,
    limit: 5,
  });

  const lines: string[] = [];
  lines.push('# [MG] Member scanner report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Subreddit: r/${asciiSafe(args.sub)}`);
  lines.push(`Target user: ${userLink(normalizedUser)}`);
  lines.push(`Scan scenario: ${asciiSafe(args.scenarioLabel)} (${asciiSafe(args.scenarioId)})`);
  lines.push(`Scenario goal: ${asciiSafe(args.scenarioPrompt)}`);
  if (args.requestedBy && args.requestedBy.trim().length > 0) {
    lines.push(`Requested by: ${userLink(args.requestedBy)}`);
  }

  lines.push('');
  lines.push('## Profile snapshot');
  if (snapshot.profile) {
    lines.push(`- Account age: ${snapshot.profile.accountAgeDays} days`);
    lines.push(`- Sitewide karma: link=${snapshot.profile.linkKarma}, comment=${snapshot.profile.commentKarma}`);
    lines.push(`- Sub karma: post=${snapshot.profile.subKarmaPost}, comment=${snapshot.profile.subKarmaComment}`);
    lines.push(`- Mod notes: ${snapshot.profile.modNoteCount}`);
    if (snapshot.profile.modNoteSummary) {
      lines.push(`- Mod note summary: ${asciiSafe(snapshot.profile.modNoteSummary)}`);
    }
    lines.push(`- Shadowbanned: ${snapshot.profile.shadowbanned ? 'yes' : 'no'}`);
    lines.push(`- NSFW profile: ${snapshot.profile.nsfw ? 'yes' : 'no'}`);
    lines.push(`- Verified email: ${snapshot.profile.hasVerifiedEmail ? 'yes' : 'no'}`);
  } else {
    lines.push('- Profile snapshot unavailable for this user.');
  }

  lines.push('');
  lines.push('## Simulated scan notes');
  lines.push(`- This report used preset scenario "${asciiSafe(args.scenarioLabel)}" to preview MG evidence format.`);
  lines.push('- Notes are for moderator testing and workflow rehearsal.');

  lines.push('');
  lines.push('## Recent comments (latest 5)');
  if (snapshot.recentComments.length === 0) {
    lines.push('- No recent comments available.');
  } else {
    for (const comment of snapshot.recentComments) {
      const dateStr = comment.createdAtIso.slice(0, 10);
      lines.push(`- [${dateStr}] r/${asciiSafe(comment.subreddit)} score=${comment.score}: ${asciiSafe(comment.body)}`);
    }
  }

  lines.push('');
  lines.push('*Internal moderator note generated by Mail Guardian Member Scanner.*');
  const body = lines.join('\n');

  await waitMs(delayBeforeAction('modmail-pm', false));

  const scannerSubredditId = args.subredditId;
  if (modMail.createModDiscussionConversation && scannerSubredditId) {
    try {
      console.log('[MG/member-scanner] posting via createModDiscussionConversation', {
        sub: args.sub,
        subredditId: args.subredditId,
        subject,
      });
      const conversationId = await withTimeout(
        () => withRateLimitRetry(
          () => modMail.createModDiscussionConversation({
            subject,
            bodyMarkdown: body,
            subredditId: scannerSubredditId,
          }),
          { actionType: 'modmail-pm', sub: args.sub, thingId: null },
        ),
        PM_TIMEOUT_MS,
        { actionType: 'modmail-pm', sub: args.sub, thingId: null },
      );
      console.log('[MG/member-scanner] posted via createModDiscussionConversation', {
        sub: args.sub,
        conversationId,
      });
      return { posted: true, reason: 'posted-mod-discussion', subject };
    } catch (e) {
      console.warn('[MG/member-scanner] createModDiscussionConversation failed, falling back to createConversation', {
        sub: args.sub,
        subredditId: args.subredditId,
        err: (e as Error)?.message ?? 'err',
      });
    }
  }

  try {
    console.log('[MG/member-scanner] posting via createConversation fallback', {
      sub: args.sub,
      subject,
      to: null,
    });
    await withTimeout(
      () => withRateLimitRetry(
        () => modMail.createConversation({
          subredditName: args.sub,
          subject,
          body,
          to: null,
          isAuthorHidden: true,
        }),
        { actionType: 'modmail-pm', sub: args.sub, thingId: null },
      ),
      PM_TIMEOUT_MS,
      { actionType: 'modmail-pm', sub: args.sub, thingId: null },
    );
    console.log('[MG/member-scanner] posted via createConversation fallback', {
      sub: args.sub,
      subject,
    });
    return { posted: true, reason: 'posted-fallback', subject };
  } catch (e) {
    console.error('[MG/member-scanner] failed to post', {
      sub: args.sub,
      subredditId: args.subredditId ?? null,
      targetUsername: normalizedUser,
      scenarioId: args.scenarioId,
      err: (e as Error)?.message ?? 'err',
      subject,
    });
    return { posted: false, reason: `failed:${(e as Error)?.message ?? 'err'}`, subject };
  }
}

export async function maybePmMods(args: MaybePmModsArgs): Promise<{ sent: boolean; reason: string }> {
  if (!pmThresholdAllowsLevel(args.threshold, args.severity.level)) {
    return { sent: false, reason: 'below-threshold' };
  }
  const fp = severityFingerprint(args.severity);
  const claimed = await claimPmFingerprint(args.sub, args.conversationId, fp);
  if (!claimed) return { sent: false, reason: 'fingerprint-already-sent' };

  const link = `https://mod.reddit.com/mail/perma/${args.conversationId}`;
  const users = collectInvolvedUsers(args);
  const thingLink = relatedThingLink(args.thingId);
  const harassmentSnippets = collectHarassmentSnippets(args);
  const evLines = (args.evidence?.items ?? [])
    .filter((it) => it.summary)
    .map((it) => `- ${it.kind} (${it.ok ? 'ok' : 'fail'}): ${it.summary}`);

  const lines: string[] = [];
  lines.push('# Mail Guardian triage notice');
  if (args.urgency === true) lines.push('**Urgency:** urgent');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**Subreddit:** r/${args.sub}`);
  lines.push(`**Conversation:** ${args.conversationId}`);
  lines.push(`**OP:** ${userLink(args.participantUser)}`);
  lines.push(`**Users involved:** ${users.map(userLink).join(', ')}`);
  if (thingLink) lines.push(`**Related post/comment:** ${thingLink}`);
  lines.push(`**Severity:** ${args.severity.level}/5 (${SEVERITY_LEVEL_LABEL[args.severity.level] ?? String(args.severity.level)})`);
  lines.push(`**Categories:** ${args.severity.categories.join(', ') || 'none'}`);
  if (args.severity.rationale) lines.push(`**Rationale:** ${asciiSafe(args.severity.rationale)}`);
  if (evLines.length > 0) {
    lines.push('');
    lines.push('### Evidence summary');
    lines.push('');
    for (const e of evLines) lines.push(asciiSafe(e));
  }
  if (harassmentSnippets.length > 0) {
    lines.push('');
    lines.push('### Evidence snippets');
    lines.push('');
    for (const s of harassmentSnippets) lines.push(`> ${s}`);
  }
  const pmProfile = collectUserProfile(args);
  if (pmProfile) {
    lines.push('');
    lines.push('### User profile');
    lines.push('');
    lines.push(`- **Account age:** ${pmProfile.profileAccountAgeDays} days`);
    lines.push(`- **Sitewide karma:** link=${pmProfile.profileLinkKarma} comment=${pmProfile.profileCommentKarma}`);
    lines.push(`- **Sub karma:** post=${pmProfile.profileSubKarmaPost} comment=${pmProfile.profileSubKarmaComment}`);
    if (pmProfile.profileModNoteCount > 0) {
      const noteSuffix = pmProfile.profileModNoteSummary ? ` -- ${asciiSafe(pmProfile.profileModNoteSummary)}` : '';
      lines.push(`- **Mod notes:** ${pmProfile.profileModNoteCount}${noteSuffix}`);
    }
    if (pmProfile.profileShadowbanned) lines.push('- **Shadowbanned:** yes');
    if (pmProfile.profileNsfw) lines.push('- **NSFW profile:** yes');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`**Body excerpt:** ${clipExcerpt(args.bodyExcerpt)}`);
  lines.push('');
  lines.push(`[Open in modmail](${link})`);
  lines.push('');
  lines.push('---');
  lines.push('*-- Mail Guardian*');

  const body = lines.join('\n');
  const urgencyPrefix = args.urgency === true ? '[URGENT] ' : '';
  const subject = `${urgencyPrefix}[MG] severity ${args.severity.level} in convo ${args.conversationId}`;

  const modMail = pmApi();
  if (!modMail.createConversation) return { sent: false, reason: 'pm-unsupported' };

  await waitMs(delayBeforeAction('modmail-pm', true));
  try {
    await withTimeout(
      () => withRateLimitRetry(
        () => modMail.createConversation({ subredditName: args.sub, subject, body, isAuthorHidden: true }),
        { actionType: 'modmail-pm', sub: args.sub, thingId: args.conversationId },
      ),
      PM_TIMEOUT_MS,
      { actionType: 'modmail-pm', sub: args.sub, thingId: args.conversationId },
    );
    try {
      if (modMail.reply) {
        await waitMs(delayBeforeAction('modmail-reply', false));
        const escalationBody = await buildEscalationNote(args);
        await withTimeout(
          () => withRateLimitRetry(
            () => modMail.reply({ conversationId: args.conversationId, body: escalationBody, isInternal: true, isAuthorHidden: true }),
            { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
          ),
          PM_TIMEOUT_MS,
          { actionType: 'modmail-reply', sub: args.sub, thingId: args.conversationId },
        );
      }
    } catch (noteErr) {
      console.warn('[MG] escalation-note post failed', {
        conversationId: args.conversationId,
        err: (noteErr as Error)?.message,
      });
    }
    return { sent: true, reason: 'pm-sent' };
  } catch (e) {
    await releasePmFingerprint(args.sub, args.conversationId, fp);
    return { sent: false, reason: `pm-failed: ${(e as Error)?.message ?? 'err'}` };
  }
}

export const __testables = {
  buildEscalationNoteFromAccuserComments,
  buildDetailedConversationReport,
  buildDetailedConversationSnapshot,
  summarizeDetailedReportChanges,
  buildSupersedingDetailedConversationReport,
};
