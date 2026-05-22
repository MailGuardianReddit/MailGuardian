// SPDX-License-Identifier: GPL-3.0-only

import type { DraftCandidate } from '../../shared/automail';

const TITLE_LINE_RE = /(?:^|\n)\s*(?:draft\s+)?title\s*:\s*(.+)$/im;
const BODY_BLOCK_RE = /(?:^|\n)\s*(?:draft\s+)?body\s*:\s*([\s\S]+)$/im;

function cleanAscii(text: string, maxLen: number): string {
  return (text ?? '')
    .replace(/[\u2014\u2013]/g, '--')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ')
    .replace(/\r/g, '')
    .trim()
    .slice(0, maxLen);
}

export function extractDraftCandidateFromText(text: string): DraftCandidate | null {
  const source = text ?? '';
  const titleMatch = source.match(TITLE_LINE_RE);
  const bodyMatch = source.match(BODY_BLOCK_RE);
  if (!titleMatch?.[1] || !bodyMatch?.[1]) return null;

  const title = cleanAscii(titleMatch[1], 300);
  const body = cleanAscii(bodyMatch[1], 3000);
  if (!title || !body) return null;
  return { title, body };
}

export function normalizeDraftCandidate(input: {
  title?: string;
  body?: string;
}): DraftCandidate | null {
  const title = cleanAscii(input.title ?? '', 300);
  const body = cleanAscii(input.body ?? '', 3000);
  if (!title || !body) return null;
  return { title, body };
}

export function looksLikeBypassRequest(text: string): boolean {
  const t = cleanAscii(text.toLowerCase(), 1200);
  if (!t) return false;
  return /bypass|evade|get around|avoid detection|beat automod|trick mods|sneak past/.test(t);
}
