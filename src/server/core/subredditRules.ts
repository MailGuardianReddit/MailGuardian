// SPDX-License-Identifier: GPL-3.0-only
// Subreddit rules text fetch with simple redis cache.

import { reddit, redis } from '@devvit/web/server';
import { k } from '../../shared/redisKeys';
import { OFFICIAL_RULES_TEMPLATE_MODERATOR_SUPPORTIVE } from '@ai';
import type { PostingRequirement, PostingRequirementSource, SubredditPolicyContext } from '../../shared/automail';

const TTL_SEC = 60 * 60; // 1h

type SubRule = { shortName?: string; description?: string };

export type SubredditRulesContext = {
  sub: string;
  rulesText: string;
};

interface SubredditReadApi {
  getRules: (sub: string) => Promise<SubRule[]>;
  getWikiPage: (sub: string, page: string) => Promise<{ content: string }>;
}

function readApi(): SubredditReadApi {
  return reddit as unknown as SubredditReadApi;
}

function extractAutomodLikeStructuredText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  const automodKey = /^\s*(type|author|body|title|domain|url|action|set_flair|reports|modmail|comment|message|priority|is_contributor|is_moderator|includes_word|regex|satisfy_any_threshold)\s*:/i;
  const yamlListKey = /^\s*-[\s]*(type|author|body|title|domain|url|action|set_flair|reports|modmail|comment|message|priority|regex)\s*:/i;
  const yamlSep = /^\s*---\s*$/;
  let keyHits = 0;
  for (const line of lines) {
    if (automodKey.test(line) || yamlListKey.test(line) || yamlSep.test(line)) {
      keyHits++;
      kept.push(line);
      continue;
    }
    if (/^\s*(#.*)?$/.test(line)) {
      kept.push(line);
      continue;
    }
    if (/^\s{2,}[A-Za-z0-9_\-]+\s*:/.test(line)) {
      kept.push(line);
    }
  }
  if (keyHits < 2) return '';
  return kept.join('\n').trim();
}

function compactAscii(text: string, maxLen: number): string {
  return text
    .replace(/[\u2014\u2013]/g, '--')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function pushRequirement(list: PostingRequirement[], requirement: PostingRequirement): void {
  if (list.some((item) => item.kind === requirement.kind && item.minimum === requirement.minimum && item.raw === requirement.raw)) return;
  list.push(requirement);
}

export function extractPostingRequirementsFromText(source: PostingRequirementSource, raw: string): PostingRequirement[] {
  const requirements: PostingRequirement[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const lower = line.toLowerCase();
    const rawLine = compactAscii(line, 240);
    if (!rawLine) continue;

    const karmaMatch = lower.match(/\b(?:at least|minimum|min\.?|must have|needs?|requires?)\s*(\d{1,5})\s*((comment|link)\s*)?karma\b/)
      ?? lower.match(/\b(\d{1,5})\s*((comment|link)\s*)?karma\b/);
    if (karmaMatch) {
      const minimum = Number.parseInt(karmaMatch[1] ?? '0', 10);
      if (Number.isFinite(minimum) && minimum > 0) {
        const kind = karmaMatch[3] === 'comment'
          ? 'comment_karma'
          : karmaMatch[3] === 'link'
            ? 'link_karma'
            : 'karma';
        pushRequirement(requirements, { kind, minimum, source, raw: rawLine });
      }
    }

    const ageMatch = lower.match(/\b(?:at least|minimum|min\.?|must be|needs?|requires?)\s*(\d{1,4})\s*(day|week|month|year)s?\b/)
      ?? lower.match(/\b(\d{1,4})\s*(day|week|month|year)s?\s*old\b/);
    if (ageMatch) {
      const minimum = Number.parseInt(ageMatch[1] ?? '0', 10);
      if (Number.isFinite(minimum) && minimum > 0) {
        const unit = ageMatch[2];
        const days = unit === 'week' ? minimum * 7 : unit === 'month' ? minimum * 30 : unit === 'year' ? minimum * 365 : minimum;
        pushRequirement(requirements, { kind: 'account_age_days', minimum: days, source, raw: rawLine });
      }
    }

    const postCountMatch = lower.match(/\b(?:at least|minimum|min\.?|must have|needs?|requires?)\s*(\d{1,5})\s*(posts?|comments?)\b/);
    if (postCountMatch) {
      const minimum = Number.parseInt(postCountMatch[1] ?? '0', 10);
      if (Number.isFinite(minimum) && minimum > 0) {
        const kind = postCountMatch[2]?.startsWith('comment') ? 'comment_count' : 'post_count';
        pushRequirement(requirements, { kind, minimum, source, raw: rawLine });
      }
    }
  }
  return requirements;
}

async function readWikiSummary(sub: string): Promise<{ summary: string; hasWiki: boolean }> {
  try {
    const page = await readApi().getWikiPage(sub, 'index');
    const raw = typeof page?.content === 'string' ? page.content : '';
    const structured = extractAutomodLikeStructuredText(raw);
    return {
      summary: structured ? compactAscii(structured, 1200) : '(wiki has no automod-like structured content)',
      hasWiki: structured.length > 0,
    };
  } catch {
    return { summary: '(wiki unavailable)', hasWiki: false };
  }
}

async function readAutomodSummary(sub: string): Promise<{ summary: string; hasAutomod: boolean }> {
  try {
    const page = await readApi().getWikiPage(sub, 'config/automoderator');
    const raw = typeof page?.content === 'string' ? page.content : '';
    const structured = extractAutomodLikeStructuredText(raw);
    return {
      summary: structured ? compactAscii(structured, 1200) : '(automod page has no structured rules)',
      hasAutomod: structured.length > 0,
    };
  } catch {
    return { summary: '(automod source unavailable)', hasAutomod: false };
  }
}

export async function getSubredditRulesContext(sub: string): Promise<SubredditRulesContext> {
  try {
    const cached = await redis.get(k.rulesCache(sub));
    if (cached) return { sub, rulesText: cached };
  } catch { /* ignore */ }

  let rules: SubRule[] = [];
  try {
    rules = await readApi().getRules(sub);
  } catch { /* ignore */ }

  const rulesText = rules
    .map((r, i) => {
      const name = (r.shortName ?? '').trim() || `Rule ${i + 1}`;
      const desc = (r.description ?? '').trim();
      return desc ? `${i + 1}. ${name}: ${desc}` : `${i + 1}. ${name}`;
    })
    .join('\n') || '(no rules published)';

  try {
    await redis.set(k.rulesCache(sub), rulesText);
    await redis.expire(k.rulesCache(sub), TTL_SEC);
  } catch { /* ignore */ }
  return { sub, rulesText };
}

export async function getSubredditPolicyContext(sub: string): Promise<SubredditPolicyContext> {
  const rules = await getSubredditRulesContext(sub);
  const [wiki, automod] = await Promise.all([
    readWikiSummary(sub),
    readAutomodSummary(sub),
  ]);
  const postingRequirements = [
    ...extractPostingRequirementsFromText('rules', rules.rulesText),
    ...extractPostingRequirementsFromText('wiki', wiki.summary),
    ...extractPostingRequirementsFromText('automod', automod.summary),
  ];
  return {
    sub,
    rulesText: rules.rulesText,
    wikiSummary: wiki.summary,
    automodSummary: automod.summary,
    postingRequirements,
    capabilities: {
      hasRules: rules.rulesText !== '(no rules published)',
      hasWiki: wiki.hasWiki,
      hasAutomod: automod.hasAutomod,
    },
  };
}

export function getPolicyRequirementSummary(requirements: PostingRequirement[]): string {
  if (requirements.length === 0) return '(no posting requirements detected)';
  return requirements.map((req) => `${req.kind}:${req.minimum} (${req.source})`).join(', ');
}

export function buildOfficialRulesPromptBlock(rulesText: string): string {
  return OFFICIAL_RULES_TEMPLATE_MODERATOR_SUPPORTIVE.replace('{rules}', rulesText);
}
