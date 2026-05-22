// SPDX-License-Identifier: GPL-3.0-only
// Menu endpoints for Mail Guardian. All three are mod-gated and return
// either a Devvit form (showForm) or a toast (showToast).

import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';
import {
  AUTOMAIL_SCAN_STATES,
  AUTOMAIL_STATE_LABELS,
  PM_THRESHOLDS,
  PM_THRESHOLD_LABELS,
  type AutoMailScanState,
  type PmThreshold,
} from '../../shared/automail';
import { isCurrentUserMod } from '../core/modGate';
import {
  addSubscriber,
  getSettings,
  getTonePrompt,
  removeSubscriber,
  saveSettings,
} from '../core/automailStore';
import { MOD_KEY_SLOTS, clearModKeySlot, listModKeySlots, saveModKeySlot } from '../core/aiConfigStore';
import { generateTonePrompt } from '../core/automailTone';
import { runScan } from '../core/automailScan';
import { sendMemberScannerReportToMods } from '../core/modPm';

export const menu = new Hono();

type MemberScannerScenario = {
  id: string;
  label: string;
  prompt: string;
};

const AUTOMAIL_SCAN_SETTINGS_STATES: readonly AutoMailScanState[] =
  AUTOMAIL_SCAN_STATES.filter((s) => s !== 'mod');

const DEFAULT_MEMBER_SCANNER_SCENARIO: MemberScannerScenario = {
  id: 'baseline',
  label: 'Baseline profile scan',
  prompt: 'General profile and recent activity summary for quick moderator context.',
};

const MEMBER_SCANNER_SCENARIOS: readonly MemberScannerScenario[] = [
  DEFAULT_MEMBER_SCANNER_SCENARIO,
  {
    id: 'harassment',
    label: 'Harassment signal sweep',
    prompt: 'Focus on hostile language patterns and repeat conflict indicators.',
  },
  {
    id: 'ban-appeal',
    label: 'Ban appeal risk review',
    prompt: 'Focus on compliance markers and prior enforcement footprint.',
  },
  {
    id: 'brigading',
    label: 'Brigading pattern probe',
    prompt: 'Focus on cross-subreddit activity spikes and coordination hints.',
  },
] as const;

function findMemberScannerScenario(id: string): MemberScannerScenario {
  const found = MEMBER_SCANNER_SCENARIOS.find((item) => item.id === id);
  return found ?? DEFAULT_MEMBER_SCANNER_SCENARIO;
}

function normalizeScannerUsername(raw: string): string {
  return raw.replace(/^u\//i, '').trim();
}

function denied(): UiResponse {
  return { showToast: { text: 'Moderators only.', appearance: 'neutral' } };
}

function noSub(): UiResponse {
  return { showToast: { text: 'No subreddit context.', appearance: 'neutral' } };
}

// ---------------------------------------------------------------------------
// 1. Open settings form
// ---------------------------------------------------------------------------
menu.post('/open-settings', async (c) => {
  const sub = context.subredditName;
  const username = context.username;
  if (!sub) return c.json<UiResponse>(noSub(), 200);
  if (!username || !(await isCurrentUserMod())) return c.json<UiResponse>(denied(), 200);

  const settings = await getSettings(sub);
  const slots = await listModKeySlots(sub, username);
  const has = (s: AutoMailScanState) => settings.respondToStates.includes(s);
  const slotStatus = slots
    .map((entry) => {
      const when = entry.updatedAt > 0 ? new Date(entry.updatedAt).toISOString().slice(0, 10) : 'never';
      return `slot ${entry.slot}: ${entry.hasKey ? 'set' : 'empty'} (updated ${when})`;
    })
    .join(' | ');

  return c.json<UiResponse>({
    showForm: {
      name: 'amu-settings',
      form: {
        title: 'AutoMail Mod Ultra - Settings',
        description:
          'Configure AI-powered Mod Mail auto-replies for r/' + sub + '. Manage up to 3 private API key slots for your moderator account.',
        acceptLabel: 'Save',
        cancelLabel: 'Cancel',
        fields: [
          {
            type: 'paragraph',
            name: 'apiSlotStatus',
            label: 'Your key slots',
            defaultValue: slotStatus,
            disabled: true,
          },
          {
            type: 'select',
            name: 'apiKeySlot',
            label: 'API key slot to update',
            helpText: 'Choose the slot you want to save or clear. Slots rotate round-robin during runtime.',
            options: Array.from({ length: MOD_KEY_SLOTS }, (_, idx) => {
              const slot = idx + 1;
              return { label: `Slot ${slot}`, value: String(slot) };
            }),
            defaultValue: ['1'],
          },
          {
            type: 'string',
            name: 'apiKey',
            label: 'Gemini API key for selected slot (leave blank to keep current value)',
            helpText: 'Stored privately. Type CLEAR to remove the selected slot from rotation.',
            scope: 'app',
            isSecret: true,
            required: false,
          },
          {
            type: 'boolean',
            name: 'enabled',
            label: 'Enable AI auto-replies',
            defaultValue: settings.enabled,
          },
          ...AUTOMAIL_SCAN_SETTINGS_STATES.map((s) => ({
            type: 'boolean' as const,
            name: 'state_' + s,
            label: 'Respond to ' + AUTOMAIL_STATE_LABELS[s] + ' conversations',
            defaultValue: has(s),
          })),
          {
            type: 'number',
            name: 'staleHours',
            label: 'Stale-nudge after (hours)',
            helpText: 'After this many quiet hours, send a polite check-in.',
            defaultValue: settings.staleHours,
          },
          {
            type: 'number',
            name: 'autoResolveAfterHours',
            label: 'Auto-archive after stale-nudge (hours)',
            helpText: 'If the user does not reply within this many hours after a nudge, archive.',
            defaultValue: settings.autoResolveAfterHours,
          },
          {
            type: 'number',
            name: 'maxReplies',
            label: 'Max AI replies per conversation',
            helpText: 'After this many AI replies, hand off to a human moderator. Allowed range 4..10.',
            defaultValue: settings.maxReplies,
          },
          {
            type: 'select',
            name: 'pmModsThreshold',
            label: 'Send mod team a private summary when severity is at least',
            helpText: 'Inclusive: a level >= this number triggers a triage PM. Sent at most once per (convo, severity) pair. CSAM categories always PM regardless.',
            options: PM_THRESHOLDS.map((t) => ({ label: PM_THRESHOLD_LABELS[t], value: String(t) })),
            defaultValue: [String(settings.pmModsThreshold)],
          },
          {
            type: 'boolean',
            name: 'transcriptEnabled',
            label: 'Generate mod-only translated transcript',
            helpText: 'After each AI reply, store an English transcript visible only to mods.',
            defaultValue: settings.transcriptEnabled,
          },
          {
            type: 'string',
            name: 'generatedSignature',
            label: 'AI-generated response signature',
            helpText: 'Appended to every AI-authored modmail response for transparency.',
            defaultValue: settings.generatedSignature ?? '',
            required: false,
          },
        ],
      },
    },
  });
});

menu.post('/api-keys', async (c) => {
  return menu.fetch(new Request(new URL('/open-settings', c.req.url), {
    method: 'POST',
    headers: c.req.raw.headers,
    body: c.req.raw.body,
  }));
});

// ---------------------------------------------------------------------------
// 2. Settings form submit
// ---------------------------------------------------------------------------
menu.post('/forms/settings', async (c) => {
  const sub = context.subredditName;
  const username = context.username;
  if (!sub) return c.json<UiResponse>(noSub(), 200);
  if (!username || !(await isCurrentUserMod())) return c.json<UiResponse>(denied(), 200);

  let values: Record<string, unknown> = {};
  try {
    const body = await c.req.json<{ values?: Record<string, unknown> }>();
    values = (body.values && typeof body.values === 'object') ? body.values : (body as Record<string, unknown>);
  } catch { /* tolerate */ }

  const apiKeyRaw = typeof values['apiKey'] === 'string' ? (values['apiKey'] as string).trim() : '';
  const slotRaw = Array.isArray(values['apiKeySlot'])
    ? (values['apiKeySlot'] as unknown[])[0]
    : values['apiKeySlot'];
  const slotNum = Number(slotRaw);
  const selectedSlot = Number.isFinite(slotNum)
    ? Math.max(1, Math.min(MOD_KEY_SLOTS, Math.floor(slotNum)))
    : 1;
  if (apiKeyRaw.toUpperCase() === 'CLEAR') {
    await clearModKeySlot(sub, username, selectedSlot);
  } else if (apiKeyRaw.length > 0) {
    await saveModKeySlot(sub, username, selectedSlot, apiKeyRaw);
  }

  const respondToStates: AutoMailScanState[] = [];
  for (const s of AUTOMAIL_SCAN_SETTINGS_STATES) {
    if (Boolean(values['state_' + s])) respondToStates.push(s);
  }

  const cur = await getSettings(sub);
  const enabled = Boolean(values['enabled']);
  const staleHours = Number(values['staleHours']);
  const autoResolveAfterHours = Number(values['autoResolveAfterHours']);
  const maxReplies = Number(values['maxReplies']);
  const transcriptEnabled = Boolean(values['transcriptEnabled']);
  const signatureInput = typeof values['generatedSignature'] === 'string'
    ? values['generatedSignature'].trim()
    : '';
  const thresholdRaw = Array.isArray(values['pmModsThreshold'])
    ? (values['pmModsThreshold'] as unknown[])[0]
    : values['pmModsThreshold'];
  const thresholdNum = Number(thresholdRaw);
  const pmModsThreshold: PmThreshold =
    Number.isFinite(thresholdNum) && (PM_THRESHOLDS as readonly number[]).includes(Math.floor(thresholdNum))
      ? (Math.floor(thresholdNum) as PmThreshold)
      : cur.pmModsThreshold;

  const next = await saveSettings(sub, {
    ...cur,
    enabled,
    respondToStates,
    staleHours: Number.isFinite(staleHours) ? staleHours : cur.staleHours,
    autoResolveAfterHours: Number.isFinite(autoResolveAfterHours) ? autoResolveAfterHours : cur.autoResolveAfterHours,
    maxReplies: Number.isFinite(maxReplies) ? maxReplies : cur.maxReplies,
    pmModsThreshold,
    transcriptEnabled,
    generatedSignature: signatureInput.length > 0 ? signatureInput : (cur.generatedSignature ?? ''),
  });

  if (next.enabled) await addSubscriber(sub);
  else await removeSubscriber(sub);

  return c.json<UiResponse>({
    showToast: {
      text: 'Saved. AutoMail is ' + (next.enabled ? 'ON' : 'off') + ' for r/' + sub + '.',
      appearance: 'success',
    },
  });
});

// ---------------------------------------------------------------------------
// 3. Scan now
// ---------------------------------------------------------------------------
menu.post('/scan-now', async (c) => {
  const sub = context.subredditName;
  if (!sub) return c.json<UiResponse>(noSub(), 200);
  if (!(await isCurrentUserMod())) return c.json<UiResponse>(denied(), 200);

  try {
    const r = await runScan(sub);
    const summary =
      'Scanned ' + r.scanned +
      ', replied ' + r.replied +
      ', nudged ' + r.staleNudged +
      ', archived ' + r.autoArchived +
      ', skipped ' + r.skipped +
      (r.errors > 0 ? ', errors ' + r.errors : '') +
      (r.notes.length > 0 ? ' (' + r.notes.slice(0, 2).join('; ') + ')' : '');
    return c.json<UiResponse>({
      showToast: { text: summary, appearance: r.errors > 0 ? 'neutral' : 'success' },
    });
  } catch (err) {
    return c.json<UiResponse>({
      showToast: { text: 'Scan failed: ' + ((err as Error)?.message ?? 'unknown'), appearance: 'neutral' },
    }, 200);
  }
});

// ---------------------------------------------------------------------------
// 4. View / regenerate tone form
// ---------------------------------------------------------------------------
menu.post('/tone', async (c) => {
  const sub = context.subredditName;
  if (!sub) return c.json<UiResponse>(noSub(), 200);
  if (!(await isCurrentUserMod())) return c.json<UiResponse>(denied(), 200);

  const cur = (await getTonePrompt(sub)) ?? '(none yet)';
  return c.json<UiResponse>({
    showForm: {
      name: 'amu-tone',
      form: {
        title: 'AutoMail Mod Ultra - Tone',
        description: 'Current voice/tone guide used to draft replies.',
        acceptLabel: 'Submit',
        cancelLabel: 'Close',
        fields: [
          {
            type: 'paragraph',
            name: 'currentPrompt',
            label: 'Current prompt',
            defaultValue: cur,
            disabled: true,
          },
          {
            type: 'boolean',
            name: 'regenerate',
            label: 'Regenerate from scratch',
            defaultValue: false,
          },
        ],
      },
    },
  });
});

menu.post('/forms/tone', async (c) => {
  const sub = context.subredditName;
  if (!sub) return c.json<UiResponse>(noSub(), 200);
  if (!(await isCurrentUserMod())) return c.json<UiResponse>(denied(), 200);

  let regenerate = false;
  try {
    const body = await c.req.json<{ values?: Record<string, unknown> }>();
    const values = (body.values && typeof body.values === 'object') ? body.values : (body as Record<string, unknown>);
    regenerate = Boolean(values['regenerate']);
  } catch { /* tolerate */ }

  if (!regenerate) {
    return c.json<UiResponse>({ showToast: { text: 'No change.', appearance: 'neutral' } });
  }

  try {
    const out = await generateTonePrompt(sub);
    return c.json<UiResponse>({
      showToast: { text: 'Tone prompt regenerated (v' + out.version + ').', appearance: 'success' },
    });
  } catch (err) {
    return c.json<UiResponse>({
      showToast: { text: 'Tone regen failed: ' + ((err as Error)?.message ?? 'unknown'), appearance: 'neutral' },
    }, 200);
  }
});

// ---------------------------------------------------------------------------
// 5. Member scanner
// ---------------------------------------------------------------------------
menu.post('/member-scanner', async (c) => {
  const sub = context.subredditName;
  if (!sub) return c.json<UiResponse>(noSub(), 200);
  if (!(await isCurrentUserMod())) return c.json<UiResponse>(denied(), 200);

  return c.json<UiResponse>({
    showForm: {
      name: 'amu-member-scanner',
      form: {
        title: 'Mail Guardian - Member Scanner',
        description: 'Scan any Reddit username and post an internal modmail note to the moderator team.',
        acceptLabel: 'Run Scanner',
        cancelLabel: 'Cancel',
        fields: [
          {
            type: 'string',
            name: 'targetUsername',
            label: 'Target Reddit username',
            helpText: 'Enter a username with or without the u/ prefix.',
            required: true,
          },
          {
            type: 'select',
            name: 'scanScenario',
            label: 'Preset scan scenario',
            options: MEMBER_SCANNER_SCENARIOS.map((scenario) => ({
              label: scenario.label,
              value: scenario.id,
            })),
            defaultValue: [DEFAULT_MEMBER_SCANNER_SCENARIO.id],
            required: true,
          },
        ],
      },
    },
  });
});

menu.post('/forms/member-scanner', async (c) => {
  const sub = context.subredditName;
  const subredditId = context.subredditId;
  const requester = context.username;
  if (!sub) return c.json<UiResponse>(noSub(), 200);
  if (!(await isCurrentUserMod())) return c.json<UiResponse>(denied(), 200);

  let values: Record<string, unknown> = {};
  try {
    const body = await c.req.json<{ values?: Record<string, unknown> }>();
    values = (body.values && typeof body.values === 'object') ? body.values : (body as Record<string, unknown>);
  } catch { /* tolerate */ }

  const rawUser = typeof values['targetUsername'] === 'string' ? values['targetUsername'] : '';
  const targetUsername = normalizeScannerUsername(rawUser);
  if (!targetUsername) {
    return c.json<UiResponse>({
      showToast: { text: 'Target username is required.', appearance: 'neutral' },
    }, 200);
  }

  const scenarioRaw = Array.isArray(values['scanScenario'])
    ? (values['scanScenario'] as unknown[])[0]
    : values['scanScenario'];
  const scenarioId = typeof scenarioRaw === 'string' ? scenarioRaw : DEFAULT_MEMBER_SCANNER_SCENARIO.id;
  const scenario = findMemberScannerScenario(scenarioId);
  const typedSubredditId = typeof subredditId === 'string' && subredditId.startsWith('t5_')
    ? (subredditId as `t5_${string}`)
    : undefined;

  console.log('[MG/menu/member-scanner] submit', {
    sub,
    subredditId: subredditId ?? null,
    requester: requester ?? null,
    targetUsername,
    scenarioId: scenario.id,
  });

  const report = await sendMemberScannerReportToMods({
    sub,
    ...(typedSubredditId ? { subredditId: typedSubredditId } : {}),
    targetUsername,
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    scenarioPrompt: scenario.prompt,
    ...(requester ? { requestedBy: requester } : {}),
  });

  console.log('[MG/menu/member-scanner] result', {
    sub,
    targetUsername,
    posted: report.posted,
    reason: report.reason,
  });

  return c.json<UiResponse>({
    showToast: {
      text: report.posted
        ? `Member scanner report posted for u/${targetUsername}: ${report.subject}`
        : `Member scanner failed for u/${targetUsername}: ${report.reason}`,
      appearance: report.posted ? 'success' : 'neutral',
    },
  }, 200);
});
