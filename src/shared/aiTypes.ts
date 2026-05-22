// SPDX-License-Identifier: GPL-3.0-only
// AI-key pool entry + selection result types shared between server core
// and the @ai key rotator.

export type AiKeyPoolEntry = {
  username: string;
  apiKey: string;
  enabled: boolean;
};

export type AiKeySelectionResult =
  | { ok: true; apiKey: string; owner: string }
  | { ok: false; error: string };

export type {
  ClaimKind,
  EvidenceBundle,
  EvidenceItem,
  PmThreshold,
  SeverityCategory,
  SeverityLevel,
  SeverityResult,
} from './automail';

export { SEVERITY_RATIONALE_MAX } from './automail';
