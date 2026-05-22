// SPDX-License-Identifier: GPL-3.0-only
// Per-subreddit voice/tone prompt generation. Caches the result via the
// store so the responder can stamp it into every reply without paying
// the model call each time.

import { reddit } from '@devvit/web/server';
import { buildToneSystemPrompt, buildToneUserPrompt, callTone } from '@ai';
import { getSubredditRulesContext } from './subredditRules';
import { resolveAiKey } from './aiRuntime';
import { getSettings, getTonePrompt, saveSettings, saveTonePrompt } from './automailStore';

type SubredditMeta = { name: string; description: string };

async function fetchSubredditMeta(sub: string): Promise<SubredditMeta> {
  try {
    const s = await reddit.getSubredditByName(sub);
    const desc = (s.description ?? '').toString();
    return { name: s.name ?? sub, description: desc.slice(0, 1500) };
  } catch {
    return { name: sub, description: '' };
  }
}

export async function generateTonePrompt(sub: string): Promise<{ prompt: string; version: number }> {
  const [meta, rulesCtx, keyResolution] = await Promise.all([
    fetchSubredditMeta(sub),
    getSubredditRulesContext(sub),
    resolveAiKey(sub),
  ]);
  if (!keyResolution.ok) throw new Error(`NO_AI_KEY: ${keyResolution.error}`);

  const result = await callTone({
    apiKey: keyResolution.apiKey,
    system: buildToneSystemPrompt(meta, rulesCtx.rulesText),
    user: buildToneUserPrompt(meta, rulesCtx.rulesText),
  });

  const text = result.text.trim();
  if (!text) throw new Error('Tone prompt generation returned empty text');

  const settings = await getSettings(sub);
  const nextVersion = settings.tonePromptVersion + 1;
  await saveTonePrompt(sub, text);
  await saveSettings(sub, { ...settings, tonePromptVersion: nextVersion });
  return { prompt: text, version: nextVersion };
}

export async function ensureTonePrompt(sub: string): Promise<string> {
  const existing = await getTonePrompt(sub);
  if (existing) return existing;
  const { prompt } = await generateTonePrompt(sub);
  return prompt;
}
