// SPDX-License-Identifier: GPL-3.0-only

import type { DraftPreflightContext, KarmaGateContext, SeverityCategory, SeverityResult } from '../../shared/automail';

export type HelpfulLink = {
  label: string;
  url: string;
  note: string;
};

export type HelpfulLinkInput = {
  sub: string;
  latestUserText?: string;
  severity?: SeverityResult;
  preflight?: DraftPreflightContext;
  karmaGate?: KarmaGateContext;
};

const RULES_LINK_FALLBACK = 'https://www.reddit.com/r/{sub}/about/rules';
const HELP_CENTER_HOME = 'https://support.reddithelp.com/hc/en-us';
const REDDIT_101 = 'https://support.reddithelp.com/hc/en-us/categories/200073949-Reddit-101';
const REDDIQUETTE = 'https://support.reddithelp.com/hc/en-us/articles/205926439-Reddiquette';
const KARMA_EXPLAINED = 'https://www.reddit.com/r/NewToReddit/comments/p8t966/reddit_and_karma_explained/';
const KARMA_GUIDE = 'https://www.reddit.com/r/NewToReddit/comments/cncbt1/a_guide_to_reddit_karma/';
const HELLO_NEW_REDDITORS = 'https://www.reddit.com/r/LearnToReddit/comments/15ixh80/hello_new_redditors/';
const NEW_USER_FRIENDLY_SUBS = 'https://www.reddit.com/r/NewToReddit/wiki/index/newusersubs/';
const CONTENT_POLICY = 'https://www.redditinc.com/policies/content-policy';
const REPORTING = 'https://support.reddithelp.com/hc/en-us/articles/360058309512-How-do-I-report-a-post-or-comment';
const SAFETY = 'https://support.reddithelp.com/hc/en-us/categories/360003247491-Safety-Privacy-and-Security';
const CRISIS = 'https://support.reddithelp.com/hc/en-us/articles/360058756471-How-do-I-get-help-if-someone-is-considering-self-harm-or-suicide';

const STARTER_LINKS: HelpfulLink[] = [
  { label: 'Reddit Help Center', url: HELP_CENTER_HOME, note: 'starter overview and platform basics' },
  { label: 'Reddit 101', url: REDDIT_101, note: 'starter redditor guidance for posting and participation' },
  { label: 'Reddiquette', url: REDDIQUETTE, note: 'community etiquette and expected behavior' },
];

const LOW_KARMA_LINKS: HelpfulLink[] = [
  {
    label: 'Reddit and Karma Explained - r/NewToReddit - [MOD]u/llamageddon01',
    url: KARMA_EXPLAINED,
    note: 'how karma works and why some communities gate posting',
  },
  {
    label: 'A Guide to Reddit Karma - r/NewToReddit - u/squid50s',
    url: KARMA_GUIDE,
    note: 'practical karma-building guidance',
  },
  {
    label: 'Hello, New Redditors! - r/LearnToReddit - [MOD]u/llamageddon01',
    url: HELLO_NEW_REDDITORS,
    note: 'new user onboarding basics',
  },
  {
    label: 'New User Friendly Subreddits (Wiki Page) - r/NewToReddit',
    url: NEW_USER_FRIENDLY_SUBS,
    note: 'subreddits that are easier for newer users to participate in',
  },
];

function normalizeAscii(text: string): string {
  return text
    .replace(/[\u2014\u2013]/g, '--')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .trim();
}

function normalizeSubreddit(sub: string): string {
  const trimmed = normalizeAscii(sub).replace(/^r\//i, '').trim();
  return trimmed.length > 0 ? trimmed : 'reddit';
}

function rulesLinkForSub(sub: string): string {
  return RULES_LINK_FALLBACK.replace('{sub}', normalizeSubreddit(sub));
}

function latestUserLooksGuidanceFocused(latestUserText?: string): boolean {
  if (!latestUserText) return false;
  const text = latestUserText.toLowerCase();
  return /\b(how do i|how can i|can i post|new here|first post|allowed\?|is this allowed|rules\?|where do i post|what should i do)\b/.test(text);
}

function stableHash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function selectDeterministicKarmaLinks(seedHint?: string): HelpfulLink[] {
  const seed = seedHint && seedHint.trim().length > 0 ? seedHint.trim() : 'karma-links-default';
  const hash = stableHash(seed);
  const count = (hash % 2) + 1;
  const start = Math.floor(hash / 2) % LOW_KARMA_LINKS.length;
  const picked: HelpfulLink[] = [];
  for (let i = 0; i < count; i += 1) {
    picked.push(LOW_KARMA_LINKS[(start + i) % LOW_KARMA_LINKS.length] as HelpfulLink);
  }
  return picked;
}

function preflightShowsKarmaGateFailure(preflight?: DraftPreflightContext): boolean {
  if (!preflight) return false;
  if (preflight.result.verdict !== 'disallow') return false;
  const text = [
    preflight.result.rationale,
    preflight.result.guidance,
    ...(preflight.result.citations ?? []),
  ].join(' ').toLowerCase();
  return /\b(?:karma|comment karma|link karma|not enough karma|requires? more karma)\b/.test(text);
}

function hasConfirmedKarmaGateFailure(input: HelpfulLinkInput): boolean {
  return Boolean(input.karmaGate?.hasConfirmedKarmaGateFailure || preflightShowsKarmaGateFailure(input.preflight));
}

function looksLikeLowKarmaPostingTrouble(input: HelpfulLinkInput): boolean {
  if (hasConfirmedKarmaGateFailure(input)) return true;
  const combined = [
    input.latestUserText ?? '',
    input.preflight?.result.rationale ?? '',
    input.preflight?.result.guidance ?? '',
    ...(input.preflight?.result.citations ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return /\b(low karma|not enough karma|requires? more karma|karma requirements?|can't post|cannot post|unable to post|post removed|removed for karma|new account|account age|trouble posting|having trouble posting|posting trouble|posting because of low karma|post because of low karma)\b/.test(combined);
}

function hasCategory(severity: SeverityResult | undefined, category: SeverityCategory): boolean {
  return Boolean(severity?.categories.includes(category));
}

export function shouldIncludeHelpfulLinks(input: HelpfulLinkInput): boolean {
  if (input.preflight) return true;
  if (hasConfirmedKarmaGateFailure(input)) return true;
  if (looksLikeLowKarmaPostingTrouble(input)) return true;
  if (latestUserLooksGuidanceFocused(input.latestUserText)) return true;
  if (!input.severity) return false;
  return (
    hasCategory(input.severity, 'rules_question') ||
    hasCategory(input.severity, 'appeal') ||
    hasCategory(input.severity, 'spam') ||
    hasCategory(input.severity, 'doxxing') ||
    hasCategory(input.severity, 'threat') ||
    hasCategory(input.severity, 'self_harm') ||
    hasCategory(input.severity, 'harassment') ||
    hasCategory(input.severity, 'other')
  );
}

export function selectHelpfulLinks(input: HelpfulLinkInput): HelpfulLink[] {
  const links: HelpfulLink[] = [];
  const lowKarmaTrouble = looksLikeLowKarmaPostingTrouble(input);
  const push = (link: HelpfulLink): void => {
    if (links.some((x) => x.url === link.url)) return;
    links.push(link);
  };

  push({
    label: 'Subreddit rules',
    url: rulesLinkForSub(input.sub),
    note: `official rules for r/${normalizeSubreddit(input.sub)}`,
  });

  if (lowKarmaTrouble) {
    const selected = selectDeterministicKarmaLinks(input.karmaGate?.seedHint);
    for (const karmaLink of selected) push(karmaLink);
  }

  if (!lowKarmaTrouble && (input.preflight || latestUserLooksGuidanceFocused(input.latestUserText) || hasCategory(input.severity, 'rules_question'))) {
    for (const starter of STARTER_LINKS) push(starter);
  }

  if (hasCategory(input.severity, 'appeal') || hasCategory(input.severity, 'spam')) {
    push({ label: 'Reddit Content Policy', url: CONTENT_POLICY, note: 'sitewide rules and enforcement basics' });
  }

  if (hasCategory(input.severity, 'harassment') || hasCategory(input.severity, 'doxxing') || hasCategory(input.severity, 'threat')) {
    push({ label: 'Safety and Privacy resources', url: SAFETY, note: 'privacy, abuse, and account safety guidance' });
    push({ label: 'How to report content', url: REPORTING, note: 'report workflow for harmful content or accounts' });
    push({ label: 'Reddit Content Policy', url: CONTENT_POLICY, note: 'sitewide policy coverage for abuse and harassment' });
  }

  if (hasCategory(input.severity, 'self_harm')) {
    push({ label: 'Self-harm crisis support', url: CRISIS, note: 'urgent support and reporting guidance' });
  }

  return links.slice(0, 6);
}

export function formatRelevantLinksSection(links: HelpfulLink[]): string {
  if (links.length === 0) return '';
  const lines = links.map((link) => `- [${normalizeAscii(link.label)}](${normalizeAscii(link.url)}) - ${normalizeAscii(link.note)}`);
  return ['### Relevant links', ...lines].join('\n');
}
