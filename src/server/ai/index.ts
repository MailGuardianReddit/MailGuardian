// SPDX-License-Identifier: GPL-3.0-only
// AI tooling resolver. Build-time aliasing selects private implementation when
// available and public fallback otherwise.

import * as publicImpl from '../ai-public';
import * as selectedImpl from '@ai-private';

declare const __AMU_HAS_PRIVATE_AI__: boolean;

type AiContract = typeof publicImpl;

let resolved: AiContract = { ...publicImpl, ...selectedImpl } as AiContract;
const isTestEnv = process.env['NODE_ENV'] === 'test' || process.env['VITEST'] === 'true';
const requirePrivateLayer = process.env['AMU_REQUIRE_PRIVATE_AI'] === 'false' ? false : !isTestEnv;

if (__AMU_HAS_PRIVATE_AI__) {
  console.info('[amu/ai] using private AI tooling layer');
} else if (requirePrivateLayer) {
  throw new Error(
    'AI_TOOLING_NOT_CONFIGURED: missing src/server/ai-private runtime layer. reason=private layer not present at build time',
  );
} else {
  resolved = publicImpl;
  console.info('[amu/ai] no private layer; using public fallback runtime. reason=private layer not present at build time');
}

export const {
  buildToneSystemPrompt,
  buildToneUserPrompt,
  buildResponderSystemInstruction,
  buildCsamNeutralAck,
  buildSeveritySystemInstruction,
  parseSeverityJson,
  buildTranscriptSystemInstruction,
  RESPONDER_TOOL_DESCRIPTIONS,
  MODE_INSTRUCTIONS,
  OFFICIAL_RULES_TEMPLATE_MODERATOR_SUPPORTIVE,
  SEVERITY_SYSTEM_PROMPT_PLACEHOLDER,
  TRANSCRIPT_SYSTEM_PROMPT_PLACEHOLDER,
  STYLE_GUIDE_NO_AI_TELLS_PLACEHOLDER,
  callTone,
  callResponder,
  callSeverity,
  callTranscript,
  callDraftPreflight,
  callDecisionValidator,
  pickAiKey,
  rotatePastKey,
} = resolved;

export type {
  ToneCallInput,
  ToneCallResult,
  ResponderCallInput,
  ResponderCallResult,
  ResponderToolCall,
  SeverityCallInput,
  SeverityCallResult,
  TranscriptCallInput,
  TranscriptCallResult,
  DraftPreflightCallInput,
  DraftPreflightCallResult,
  DecisionValidationCallInput,
  DecisionValidationCallResult,
} from '../ai-public/genaiClient';
