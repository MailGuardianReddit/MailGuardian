// SPDX-License-Identifier: GPL-3.0-only
// Evidence module: cheap per-claim Devvit lookups for the responder.
// One function per ClaimKind. Each lookup is paced + retried + per-call
// AbortSignal.timeout(4000); the outer runEvidence wraps Promise.allSettled
// in an 8s wall-clock cap. Functions never throw.
//
// All Devvit symbols here are reached through narrow `unknown` casts
// because exact signatures need MCP confirmation.

import { reddit } from '@devvit/web/server';
import type { ClaimKind, EvidenceBundle, EvidenceItem, RemovedPostSample } from '../../shared/automail';
import type { ResponderConversationTurn } from '../ai-public/genaiClient';
import { delayBeforeAction, waitMs, withRateLimitRetry } from './actionPacing';

const PER_CALL_TIMEOUT_MS = 4000;
const TOTAL_BUDGET_MS = 8000;
const NEARBY_THREAD_DEPTH = 8;
const NEARBY_THREAD_LIMIT = 240;
const NEARBY_THREAD_PAGE_SIZE = 100;

const CSAM_KEYWORDS: readonly string[] = [
  'csam',
  'child porn',
  'child pornography',
  'sexualized minor',
  'minor nude',
  'underage nude',
  'underage explicit',
  'explicit minor',
  'grooming',
  'loli',
  'preteen',
  'ageplay',
];

const MINOR_TERMS = /\b(child|children|kid|kids|minor|underage|teen|teens|preteen|young girl|young boy)\b/i;
const SEXUAL_TERMS = /\b(nude|nudes|nsfw|sexual|sex|explicit|porn|naked|lewd)\b/i;
const MEDIA_TERMS = /\b(photo|image|img|pic|video|clip|screenshot|link|url|attachment|album|gallery)\b/i;
const MEDIA_URL = /https?:\/\/(?:[^\s/]+\.)?(?:reddit\.com|redd\.it|i\.redd\.it|v\.redd\.it|imgur\.com|i\.imgur\.com|gfycat\.com|redgifs\.com|youtube\.com|youtu\.be|discord\.gg|discord\.com|dropbox\.com)\//i;

export type EvidenceContext = {
  sub: string;
  username: string;
  thingId?: string;
};

export type CsamPlausibleCauseInput = {
  sub: string;
  thingId?: string;
  lastUserBody: string;
  conversation?: ResponderConversationTurn[];
};

export type CsamPlausibleCauseResult = {
  plausible: boolean;
  score: number;
  reasons: string[];
};

interface RedditEvidenceApi {
  getComments: typeof reddit.getComments;
  getCommentsByUser: typeof reddit.getCommentsByUser;
  getModerationLog: typeof reddit.getModerationLog;
  getCommentById: typeof reddit.getCommentById;
  getPostById: typeof reddit.getPostById;
  getUserByUsername: typeof reddit.getUserByUsername;
  getModNotes: typeof reddit.getModNotes;
  getUserKarmaFromCurrentSubreddit: typeof reddit.getUserKarmaFromCurrentSubreddit;
}

type UserProfileData = {
  shadowbanned: boolean;
  accountAgeDays: number;
  linkKarma: number;
  commentKarma: number;
  nsfw: boolean;
  hasVerifiedEmail: boolean;
  subKarmaPost: number;
  subKarmaComment: number;
  modNoteCount: number;
  modNoteSummary: string;
};

const HARASSMENT_TERMS = /\b(idiot|moron|stupid|trash|loser|kys|kill\s*yourself|die|freak|retard|whore|slut|harass|threat|doxx|racist|nazi)\b/i;

type NearbyContext = {
  mode: 'child-thread' | 'post-thread';
  commentCount: number;
  directChildCount: number;
  hostileCount: number;
  hostileAuthors: number;
  likelyAbusers: string[];
  hostileSnippets: string[];
};

async function fetchNearbyHarassmentContext(ctx: EvidenceContext): Promise<NearbyContext | null> {
  if (!ctx.thingId) return null;

  let postId: `t3_${string}`;
  let anchorCommentId: `t1_${string}` | undefined;

  if (ctx.thingId.startsWith('t1_')) {
    await waitMs(delayBeforeAction('reddit-read', false));
    const anchor = await withRateLimitRetry(
      () => withCallTimeout(Promise.resolve(evApi().getCommentById(ctx.thingId as `t1_${string}`))),
      { actionType: 'reddit-read', sub: ctx.sub, thingId: ctx.thingId },
    );
    postId = anchor.postId;
    anchorCommentId = anchor.id;
  } else if (ctx.thingId.startsWith('t3_')) {
    postId = ctx.thingId as `t3_${string}`;
  } else {
    return null;
  }

  await waitMs(delayBeforeAction('reddit-read', false));
  const listing = await withRateLimitRetry(
    () => withCallTimeout(Promise.resolve(evApi().getComments({
      postId,
      ...(anchorCommentId ? { commentId: anchorCommentId } : {}),
      depth: NEARBY_THREAD_DEPTH,
      limit: NEARBY_THREAD_LIMIT,
      pageSize: NEARBY_THREAD_PAGE_SIZE,
      sort: 'new',
    }))),
    { actionType: 'reddit-read', sub: ctx.sub, thingId: postId },
  );
  const all = await withCallTimeout(listing.all());

  const nearby = all.filter((c) => {
    if (anchorCommentId && c.id === anchorCommentId) return false;
    return c.authorName.toLowerCase() !== ctx.username.toLowerCase();
  });
  const directChildCount = anchorCommentId
    ? nearby.filter((c) => c.parentId === anchorCommentId).length
    : 0;
  const hostile = nearby.filter((c) => HARASSMENT_TERMS.test(c.body));
  const hostileByAuthor = new Map<string, number>();
  const hostileSnippetByAuthor = new Map<string, string>();
  for (const h of hostile) {
    const name = h.authorName.trim();
    if (!name) continue;
    hostileByAuthor.set(name, (hostileByAuthor.get(name) ?? 0) + 1);
    if (!hostileSnippetByAuthor.has(name)) {
      hostileSnippetByAuthor.set(name, compactText(h.body));
    }
  }
  const rankedAbusers = [...hostileByAuthor.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, hits]) => `${name}(${hits})`);
  const hostileSnippets = [...hostileByAuthor.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => {
      const snippet = hostileSnippetByAuthor.get(name) ?? '(no snippet)';
      return `${name}: "${snippet}"`;
    });
  const hostileAuthors = hostileByAuthor.size;

  return {
    mode: anchorCommentId ? 'child-thread' : 'post-thread',
    commentCount: nearby.length,
    directChildCount,
    hostileCount: hostile.length,
    hostileAuthors,
    likelyAbusers: rankedAbusers,
    hostileSnippets,
  };
}

type ModLogEntry = {
  type?: string;
  target?: { id?: string };
  createdAt?: Date | string;
  details?: string;
};

const evApi = (): RedditEvidenceApi => reddit as unknown as RedditEvidenceApi;

function withCallTimeout<T>(p: Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(PER_CALL_TIMEOUT_MS);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('evidence timeout'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

async function safe(label: ClaimKind, fn: () => Promise<EvidenceItem>): Promise<EvidenceItem> {
  try {
    return await fn();
  } catch (e) {
    return { kind: label, ok: false, summary: (e as Error)?.message ?? 'error' };
  }
}

async function harassedByUser(ctx: EvidenceContext): Promise<EvidenceItem> {
  return safe('harassed_by_user', async () => {
    await waitMs(delayBeforeAction('reddit-read', true));
    const list = await withRateLimitRetry(
      () => withCallTimeout(Promise.resolve(evApi().getCommentsByUser({ username: ctx.username, sort: 'new', limit: 25 }))),
      { actionType: 'reddit-read', sub: ctx.sub, thingId: null },
    );
    const all = await withCallTimeout(list.all());
    const inSub = all.filter((comment) => comment.subredditName.toLowerCase() === ctx.sub.toLowerCase());
    const lowScore = inSub.filter((comment) => comment.score < 0).length;
    const nearby = await fetchNearbyHarassmentContext(ctx).catch(() => null);
    const profile = await fetchUserProfileData(ctx).catch(() => null);
    const abusers = nearby?.likelyAbusers ?? [];
    const abuserSummary = abusers.length > 0 ? `; likely abusers: ${abusers.join(', ')}` : '';
    const nearbySummary = nearby
      ? `; ${nearby.mode}: ${nearby.commentCount} comments, ${nearby.directChildCount} direct-child, ${nearby.hostileCount} hostile-signal, ${nearby.hostileAuthors} hostile-authors${abuserSummary}`
      : '';
    const profileSummary = profile
      ? `; profile: age=${profile.accountAgeDays}d, karma=${profile.linkKarma}/${profile.commentKarma}, sub=${profile.subKarmaPost}/${profile.subKarmaComment}, notes=${profile.modNoteCount}${profile.shadowbanned ? ', SHADOWBANNED' : ''}`
      : '';
    const summary = `${inSub.length} recent comments by user in r/${ctx.sub}; ${lowScore} negative-score${nearbySummary}${profileSummary}`;
    return {
      kind: 'harassed_by_user',
      ok: true,
      summary,
      data: {
        inSub: inSub.length,
        lowScore,
        ...(nearby
          ? {
              nearbyCommentCount: nearby.commentCount,
              nearbyDirectChildCount: nearby.directChildCount,
              nearbyHostileCount: nearby.hostileCount,
              nearbyHostileAuthors: nearby.hostileAuthors,
              nearbyLikelyAbusers: nearby.likelyAbusers,
              nearbyHostileSnippets: nearby.hostileSnippets,
            }
          : {}),
        ...(profile
          ? {
              profileShadowbanned: profile.shadowbanned,
              profileAccountAgeDays: profile.accountAgeDays,
              profileLinkKarma: profile.linkKarma,
              profileCommentKarma: profile.commentKarma,
              profileNsfw: profile.nsfw,
              profileSubKarmaPost: profile.subKarmaPost,
              profileSubKarmaComment: profile.subKarmaComment,
              profileModNoteCount: profile.modNoteCount,
              profileModNoteSummary: profile.modNoteSummary,
            }
          : {}),
      },
    };
  });
}

async function contentRemovedUnfairly(ctx: EvidenceContext): Promise<EvidenceItem> {
  return safe('content_removed_unfairly', async () => {
    if (!ctx.thingId) return { kind: 'content_removed_unfairly', ok: false, summary: 'no thing id' };
    await waitMs(delayBeforeAction('reddit-read', true));
    const isComment = ctx.thingId.startsWith('t1_');
    const item = await withRateLimitRetry(
      () => withCallTimeout(Promise.resolve(isComment
        ? evApi().getCommentById(ctx.thingId as `t1_${string}`)
        : evApi().getPostById(ctx.thingId as `t3_${string}`))),
      { actionType: 'reddit-read', sub: ctx.sub, thingId: ctx.thingId },
    );
    const summary = `removed=${item.removed}, spam=${item.spam}, score=${item.score}`;
    return {
      kind: 'content_removed_unfairly',
      ok: true,
      summary,
      data: { removed: item.removed, spam: item.spam, score: item.score },
    };
  });
}

async function voteManipulated(ctx: EvidenceContext): Promise<EvidenceItem> {
  return safe('vote_manipulated', async () => {
    if (!ctx.thingId) return { kind: 'vote_manipulated', ok: false, summary: 'no thing id' };
    await waitMs(delayBeforeAction('reddit-read', true));
    const isComment = ctx.thingId.startsWith('t1_');
    const item = await withRateLimitRetry(
      () => withCallTimeout(Promise.resolve(isComment
        ? evApi().getCommentById(ctx.thingId as `t1_${string}`)
        : evApi().getPostById(ctx.thingId as `t3_${string}`))),
      { actionType: 'reddit-read', sub: ctx.sub, thingId: ctx.thingId },
    );
    const created = item.createdAt.getTime();
    const ageH = created > 0 ? (Date.now() - created) / 3_600_000 : 0;
    const score = item.score;
    const perH = ageH > 0 ? (score / ageH).toFixed(2) : 'n/a';
    const summary = `score=${score}, ageH=${ageH.toFixed(1)}, score/h=${perH}`;
    return { kind: 'vote_manipulated', ok: true, summary, data: { score, ageH, perH } };
  });
}

async function banUnfair(ctx: EvidenceContext): Promise<EvidenceItem> {
  return safe('ban_unfair', async () => {
    await waitMs(delayBeforeAction('reddit-read', true));
    const list = await withRateLimitRetry(
      () => withCallTimeout(Promise.resolve(evApi().getModerationLog({ subredditName: ctx.sub, limit: 50 }))),
      { actionType: 'reddit-read', sub: ctx.sub, thingId: null },
    );
    const all = await withCallTimeout(list.all());
    const matches = all.filter((entry) => (entry.target?.author ?? '').toLowerCase() === ctx.username.toLowerCase());
    const actions = new Set<string>();
    for (const m of matches) {
      actions.add(m.type);
    }
    const banLike = [...actions].filter((a) => /ban|mute/i.test(a));
    const profile = await fetchUserProfileData(ctx).catch(() => null);
    const profileSummary = profile
      ? `; profile: age=${profile.accountAgeDays}d, karma=${profile.linkKarma}/${profile.commentKarma}, sub=${profile.subKarmaPost}/${profile.subKarmaComment}, notes=${profile.modNoteCount}${profile.shadowbanned ? ', SHADOWBANNED' : ''}`
      : '';
    const summary = `${matches.length} mod-log entries on user; actions=${[...actions].join(',') || 'none'}; ban-like=${banLike.length}${profileSummary}`;
    return {
      kind: 'ban_unfair',
      ok: true,
      summary,
      data: {
        count: matches.length,
        actions: [...actions],
        banLike,
        ...(profile
          ? {
              profileShadowbanned: profile.shadowbanned,
              profileAccountAgeDays: profile.accountAgeDays,
              profileLinkKarma: profile.linkKarma,
              profileCommentKarma: profile.commentKarma,
              profileNsfw: profile.nsfw,
              profileSubKarmaPost: profile.subKarmaPost,
              profileSubKarmaComment: profile.subKarmaComment,
              profileModNoteCount: profile.modNoteCount,
              profileModNoteSummary: profile.modNoteSummary,
            }
          : {}),
      },
    };
  });
}

async function noneClaim(_ctx: EvidenceContext): Promise<EvidenceItem> {
  return { kind: 'none', ok: true, summary: 'no claim' };
}

function normalizeAscii(text: string): string {
  return text
    .replace(/[\u2014\u2013]/g, '--')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function csamScoreFromText(text: string): CsamPlausibleCauseResult {
  const norm = normalizeAscii(text);
  let score = 0;
  const reasons: string[] = [];

  let keywordHits = 0;
  for (const kw of CSAM_KEYWORDS) {
    if (norm.includes(kw)) keywordHits++;
  }
  if (keywordHits > 0) {
    score += Math.min(2, keywordHits);
    reasons.push(`keyword:${keywordHits}`);
  }

  const hasMinor = MINOR_TERMS.test(norm);
  const hasSexual = SEXUAL_TERMS.test(norm);
  if (hasMinor && hasSexual) {
    score += 2;
    reasons.push('minor+sexual');
  }

  const hasMedia = MEDIA_TERMS.test(norm) || MEDIA_URL.test(norm);
  if (hasMedia) {
    score += 1;
    reasons.push('media-signal');
  }

  return { plausible: score >= 2, score, reasons };
}

async function readThingText(input: CsamPlausibleCauseInput): Promise<string> {
  if (!input.thingId) return '';
  await waitMs(delayBeforeAction('reddit-read', true));
  const isComment = input.thingId.startsWith('t1_');
  if (isComment) {
    const item = await withRateLimitRetry(
      () => withCallTimeout(Promise.resolve(evApi().getCommentById(input.thingId as `t1_${string}`))),
      { actionType: 'reddit-read', sub: input.sub, thingId: input.thingId },
    );
    return item.body;
  }

  const item = await withRateLimitRetry(
    () => withCallTimeout(Promise.resolve(evApi().getPostById(input.thingId as `t3_${string}`))),
    { actionType: 'reddit-read', sub: input.sub, thingId: input.thingId },
  );
  return `${item.title}\n${item.body ?? ''}`.trim();
}

export async function evaluateCsamPlausibleCause(
  input: CsamPlausibleCauseInput,
): Promise<CsamPlausibleCauseResult> {
  const samples: string[] = [];
  if (input.lastUserBody) samples.push(input.lastUserBody);

  const turns = input.conversation ?? [];
  for (let i = turns.length - 1; i >= 0 && samples.length < 4; i--) {
    const t = turns[i];
    if (!t || t.role !== 'user') continue;
    if (t.body) samples.push(t.body);
  }

  try {
    const thingText = await readThingText(input);
    if (thingText) samples.push(thingText);
  } catch {
    // Best effort: keep local text-only signal if lookup fails.
  }

  if (samples.length === 0) return { plausible: false, score: 0, reasons: ['no-text'] };
  return csamScoreFromText(samples.join('\n'));
}

function toIso(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

function containsTopic(line: string, topic: string): boolean {
  if (!topic) return true;
  const normLine = normalizeAscii(line);
  const normTopic = normalizeAscii(topic);
  if (!normTopic) return true;
  return normLine.includes(normTopic);
}

export async function getRecentRemovedPostSamples(args: {
  sub: string;
  topic: string;
  limit?: number;
}): Promise<RemovedPostSample[]> {
  const cap = Math.max(1, Math.min(8, args.limit ?? 4));

  await waitMs(delayBeforeAction('reddit-read', true));
  const feed = await withRateLimitRetry(
    () => withCallTimeout(Promise.resolve(evApi().getModerationLog({ subredditName: args.sub, limit: 100 }))),
    { actionType: 'reddit-read', sub: args.sub, thingId: null },
  );
  const rows = await withCallTimeout(feed.all()) as ModLogEntry[];

  const kept: RemovedPostSample[] = [];
  for (const row of rows) {
    if (kept.length >= cap) break;
    const action = (row.type ?? '').toLowerCase();
    if (!/remove|spam/.test(action)) continue;
    const targetId = row.target?.id;
    if (!targetId) continue;

    let titleOrBody = '';
    if (targetId.startsWith('t3_')) {
      const post = await withRateLimitRetry(
        () => withCallTimeout(Promise.resolve(evApi().getPostById(targetId as `t3_${string}`))),
        { actionType: 'reddit-read', sub: args.sub, thingId: targetId },
      );
      titleOrBody = `${post.title} ${post.body ?? ''}`.trim();
    } else if (targetId.startsWith('t1_')) {
      const comment = await withRateLimitRetry(
        () => withCallTimeout(Promise.resolve(evApi().getCommentById(targetId as `t1_${string}`))),
        { actionType: 'reddit-read', sub: args.sub, thingId: targetId },
      );
      titleOrBody = comment.body.trim();
    }

    if (!containsTopic(`${titleOrBody} ${row.details ?? ''}`, args.topic)) continue;

    kept.push({
      thingId: targetId,
      kind: targetId.startsWith('t3_') ? 'post' : 'comment',
      titleOrBody: compactText(titleOrBody || row.details || '(no text)'),
      reason: compactText(row.details || action || 'removed'),
      removedAtIso: toIso(row.createdAt),
    });
  }
  return kept;
}

function compactText(s: string): string {
  return s
    .replace(/[\u2014\u2013]/g, '--')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
}

async function fetchUserProfileData(ctx: EvidenceContext): Promise<UserProfileData | null> {
  try {
    await waitMs(delayBeforeAction('reddit-read', false));
    const user = await withRateLimitRetry(
      () => withCallTimeout(evApi().getUserByUsername(ctx.username)),
      { actionType: 'reddit-read', sub: ctx.sub, thingId: null },
    );
    if (!user) {
      // getUserByUsername returns null either on shadowban OR if user doesn't exist.
      // Without explicit API confirmation, we can't assume shadowban, so return null instead.
      return null;
    }

    const accountAgeDays = Math.floor((Date.now() - user.createdAt.getTime()) / 86400000);

    let subKarmaPost = 0;
    let subKarmaComment = 0;
    try {
      await waitMs(delayBeforeAction('reddit-read', false));
      const subKarma = await withRateLimitRetry(
        () => withCallTimeout(evApi().getUserKarmaFromCurrentSubreddit(ctx.username)),
        { actionType: 'reddit-read', sub: ctx.sub, thingId: null },
      );
      subKarmaPost = subKarma.fromPosts ?? 0;
      subKarmaComment = subKarma.fromComments ?? 0;
    } catch {
      // best-effort
    }

    let modNoteCount = 0;
    let modNoteSummary = '';
    try {
      await waitMs(delayBeforeAction('reddit-read', false));
      const noteListing = await withRateLimitRetry(
        () => withCallTimeout(Promise.resolve(evApi().getModNotes({ subreddit: ctx.sub, user: ctx.username, filter: 'NOTE', limit: 25 }))),
        { actionType: 'reddit-read', sub: ctx.sub, thingId: null },
      );
      const notes = await withCallTimeout(noteListing.all());
      modNoteCount = notes.length;
      const snippets = notes.slice(0, 3).map((n) => {
        const label = n.userNote?.label ?? n.type;
        const dateStr = n.createdAt.toISOString().slice(0, 10);
        const text = compactText(n.userNote?.note ?? '').slice(0, 60);
        return `${label}(${dateStr}): "${text}"`;
      });
      modNoteSummary = snippets.join('; ');
    } catch {
      // best-effort
    }

    return {
      shadowbanned: false,
      accountAgeDays,
      linkKarma: user.linkKarma,
      commentKarma: user.commentKarma,
      nsfw: user.nsfw,
      hasVerifiedEmail: user.hasVerifiedEmail,
      subKarmaPost,
      subKarmaComment,
      modNoteCount,
      modNoteSummary,
    };
  } catch {
    return null;
  }
}

export type AccuserComment = {
  author: string;
  createdAtIso: string;
  body: string;
  subreddit: string;
  score: number;
  hostilityScore: number;
};

export type AccuserHostileAuthorCount = {
  author: string;
  hostileComments: number;
  currentSubHostileComments: number;
  outsideCurrentSubHostileComments: number;
};

export type AccuserCommentPattern = {
  totalComments: number;
  hostileComments: number;
  distinctAuthors: number;
  currentSubHostileComments: number;
  outsideCurrentSubHostileComments: number;
  categoryLabels: string[];
  hostileByAuthor: AccuserHostileAuthorCount[];
  outsideCurrentSubExamples: AccuserComment[];
  topThemes: string[];
};

export type UserRepComment = {
  createdAtIso: string;
  subreddit: string;
  score: number;
  body: string;
};

export type UserRepSnapshot = {
  profile: UserProfileData | null;
  recentComments: UserRepComment[];
};

export async function fetchUserRepSnapshot(args: {
  sub: string;
  username: string;
  limit?: number;
}): Promise<UserRepSnapshot> {
  const cap = Math.max(1, Math.min(5, args.limit ?? 5));
  const profile = await fetchUserProfileData({ sub: args.sub, username: args.username }).catch(() => null);

  const recentComments: UserRepComment[] = [];
  try {
    await waitMs(delayBeforeAction('reddit-read', false));
    const listing = await withRateLimitRetry(
      () => withCallTimeout(Promise.resolve(evApi().getCommentsByUser({
        username: args.username,
        sort: 'new',
        limit: 25,
        pageSize: 25,
      }))),
      { actionType: 'reddit-read', sub: args.sub, thingId: null },
    );
    const comments = await withRateLimitRetry(
      () => withCallTimeout(listing.all()),
      { actionType: 'reddit-read', sub: args.sub, thingId: null },
    );
    for (const comment of comments.slice(0, cap)) {
      recentComments.push({
        createdAtIso: comment.createdAt.toISOString(),
        subreddit: comment.subredditName,
        score: comment.score,
        body: compactText(comment.body).slice(0, 220),
      });
    }
  } catch {
    // best-effort
  }

  return { profile, recentComments };
}

export async function analyzeAccuserCommentPatterns(
  comments: AccuserComment[],
  currentSub: string,
): Promise<AccuserCommentPattern | null> {
  if (comments.length === 0) return null;

  const hostileComments = comments.filter((c) => c.hostilityScore > 0);
  if (hostileComments.length === 0) return null;

  const currentSubNorm = currentSub.toLowerCase();
  const hostileByAuthorMap = new Map<string, AccuserHostileAuthorCount>();
  let currentSubHostileComments = 0;
  let outsideCurrentSubHostileComments = 0;

  for (const comment of hostileComments) {
    const authorKey = comment.author.toLowerCase();
    const inCurrentSub = comment.subreddit.toLowerCase() === currentSubNorm;
    const entry = hostileByAuthorMap.get(authorKey) ?? {
      author: comment.author,
      hostileComments: 0,
      currentSubHostileComments: 0,
      outsideCurrentSubHostileComments: 0,
    };

    entry.hostileComments += 1;
    if (inCurrentSub) {
      entry.currentSubHostileComments += 1;
      currentSubHostileComments += 1;
    } else {
      entry.outsideCurrentSubHostileComments += 1;
      outsideCurrentSubHostileComments += 1;
    }

    hostileByAuthorMap.set(authorKey, entry);
  }

  const hostileByAuthor = [...hostileByAuthorMap.values()].sort((a, b) => {
    return (b.hostileComments - a.hostileComments)
      || (b.currentSubHostileComments - a.currentSubHostileComments)
      || a.author.localeCompare(b.author);
  });
  const distinctAuthors = hostileByAuthor.length;
  const currentSubHostileAuthors = hostileByAuthor.filter((entry) => entry.currentSubHostileComments > 0).length;

  const categoryLabels: string[] = [];
  if (currentSubHostileComments >= 2 && currentSubHostileAuthors === 1) {
    categoryLabels.push('single-user pile-on');
  }
  if (currentSubHostileComments >= 2 && currentSubHostileAuthors >= 2) {
    categoryLabels.push('multi-user pile-on');
  }
  if (outsideCurrentSubHostileComments > 0) {
    categoryLabels.push('cross-subreddit hostility');
  }
  if (hostileByAuthor.some((entry) => entry.currentSubHostileComments >= 2)) {
    categoryLabels.push('same-sub repeated abuse');
  }

  const outsideCurrentSubExamples = hostileComments
    .filter((comment) => comment.subreddit.toLowerCase() !== currentSubNorm)
    .sort((a, b) => (b.hostilityScore - a.hostilityScore) || (new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime()))
    .slice(0, 3);

  // Extract common hostile keywords from the comments
  const keywords = new Map<string, number>();
  for (const c of hostileComments) {
    const matches = c.body.match(/\b(idiot|moron|stupid|trash|loser|kys|kill|die|freak|retard|whore|slut|harass|threat|doxx|racist|nazi)\b/gi) ?? [];
    for (const m of matches) {
      keywords.set(m.toLowerCase(), (keywords.get(m.toLowerCase()) ?? 0) + 1);
    }
  }
  const topThemes = [...keywords.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);

  return {
    totalComments: comments.length,
    hostileComments: hostileComments.length,
    distinctAuthors,
    currentSubHostileComments,
    outsideCurrentSubHostileComments,
    categoryLabels,
    hostileByAuthor,
    outsideCurrentSubExamples,
    topThemes,
  };
}

export async function fetchAccuserComments(
  usernames: string[],
  currentSub: string,
  limit: number = 10,
): Promise<AccuserComment[]> {
  const results: AccuserComment[] = [];

  // Match pickax3 pattern: getCommentsByUser with sort/limit/pageSize
  for (const username of usernames.slice(0, 5)) {
    try {
      await waitMs(delayBeforeAction('reddit-read', false));
      const listing = await withRateLimitRetry(
        () => withCallTimeout(Promise.resolve(evApi().getCommentsByUser({
          username,
          sort: 'new',
          limit: 25,
          pageSize: 25,
        }))),
        { actionType: 'reddit-read', sub: currentSub, thingId: null },
      );
      const comments = await withCallTimeout(listing.all());

      for (const comment of comments) {
        if (results.length >= limit) break;

        const body = compactText(comment.body).slice(0, 300);
        const hostilityMatches = (body.match(/\b(idiot|moron|stupid|trash|loser|kys|kill|die|freak|retard|whore|slut|harass|threat|doxx|racist|nazi)\b/gi) ?? []).length;
        const hostilityScore = hostilityMatches > 0 ? hostilityMatches : 0;

        // Only include if hostile or in current subreddit
        if (hostilityScore > 0 || comment.subredditName.toLowerCase() === currentSub.toLowerCase()) {
          results.push({
            author: username,
            createdAtIso: comment.createdAt.toISOString(),
            body,
            subreddit: comment.subredditName,
            score: comment.score,
            hostilityScore,
          });
        }
      }
    } catch {
      // best-effort
    }
  }

  // Sort by hostility score (high first) then by date (recent first)
  return results.sort((a, b) => (b.hostilityScore - a.hostilityScore) || (new Date(b.createdAtIso).getTime() - new Date(a.createdAtIso).getTime()));
}

const RUNNERS: Record<ClaimKind, (ctx: EvidenceContext) => Promise<EvidenceItem>> = {
  harassed_by_user: harassedByUser,
  content_removed_unfairly: contentRemovedUnfairly,
  vote_manipulated: voteManipulated,
  ban_unfair: banUnfair,
  none: noneClaim,
};

export async function runEvidence(
  claims: ClaimKind[],
  ctx: EvidenceContext,
): Promise<EvidenceBundle> {
  const startedAt = Date.now();
  const filtered = [...new Set(claims.filter((c) => c !== 'none'))];
  if (filtered.length === 0) {
    return { items: [], truncated: false, startedAt, completedAt: startedAt };
  }
  const tasks = filtered.map((c) => RUNNERS[c](ctx));
  const cap = new Promise<'__amu_cap__'>((resolve) => setTimeout(() => resolve('__amu_cap__'), TOTAL_BUDGET_MS));
  const settled = await Promise.race([
    Promise.allSettled(tasks).then((r) => ({ kind: 'done', r } as const)),
    cap.then(() => ({ kind: 'cap' } as const)),
  ]);

  const items: EvidenceItem[] = [];
  let truncated = false;
  if (settled.kind === 'done') {
    settled.r.forEach((s, i) => {
      if (s.status === 'fulfilled') items.push(s.value);
      else {
        const k = filtered[i] ?? 'none';
        items.push({ kind: k, ok: false, summary: (s.reason as Error)?.message ?? 'rejected' });
      }
    });
  } else {
    truncated = true;
  }
  return { items, truncated, startedAt, completedAt: Date.now() };
}
