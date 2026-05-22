// SPDX-License-Identifier: GPL-3.0-only
// Mail Guardian shared types -- server + (forms)client contract.


/** Conversation states the AI may scan for. ARCHIVED is intentionally excluded. */
export type AutoMailScanState = 'new' | 'inprogress' | 'highlighted' | 'mod';

export const AUTOMAIL_SCAN_STATES: readonly AutoMailScanState[] = [
  'new',
  'inprogress',
  'highlighted',
  'mod',
] as const;

export const AUTOMAIL_STATE_LABELS: Record<AutoMailScanState, string> = {
  new: 'NEW',
  inprogress: 'IN PROGRESS',
  highlighted: 'HIGHLIGHTED',
  mod: 'INTERNAL',
};

export type SeverityLevel = 1 | 2 | 3 | 4 | 5;

export const SEVERITY_LEVELS: readonly SeverityLevel[] = [1, 2, 3, 4, 5] as const;

export const SEVERITY_RATIONALE_MAX = 240;

export type SeverityCategory =
  | 'rules_question'
  | 'appeal'
  | 'spam'
  | 'harassment'
  | 'doxxing'
  | 'threat'
  | 'self_harm'
  | 'csam'
  | 'other';

export const SEVERITY_CATEGORIES: readonly SeverityCategory[] = [
  'rules_question',
  'appeal',
  'spam',
  'harassment',
  'doxxing',
  'threat',
  'self_harm',
  'csam',
  'other',
] as const;

export type ClaimKind =
  | 'harassed_by_user'
  | 'content_removed_unfairly'
  | 'vote_manipulated'
  | 'ban_unfair'
  | 'none';

export const CLAIM_KINDS: readonly ClaimKind[] = [
  'harassed_by_user',
  'content_removed_unfairly',
  'vote_manipulated',
  'ban_unfair',
  'none',
] as const;


// --- User and context variables for full simulation ---
export type UserProfileContext = {
  username: string;
  accountAgeDays: number;
  totalKarma: number;
  postKarma: number;
  commentKarma: number;
  isBanned: boolean;
  isMuted: boolean;
  priorModActions: string[]; // e.g., ['warned', 'banned', 'muted']
  profileFlags?: string[]; // e.g., ['verified', 'suspected_alt', 'shadowbanned']
  userHistorySummary?: string; // e.g., summary of recent posts/comments
};

export type SubredditContext = {
  subreddit: string;
  subredditAgeDays: number;
  subscriberCount: number;
  nsfw: boolean;
  automodConfigVersion?: string;
  customRules?: string[];
};

export type SeverityResult = {
  level: SeverityLevel;
  categories: SeverityCategory[];
  rationale: string;
  claims: ClaimKind[];
  generatedAt: number;
  userProfile?: UserProfileContext;
  subredditContext?: SubredditContext;
};

export type EvidenceItem = {
  kind: ClaimKind;
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
};

export type EvidenceBundle = {
  items: EvidenceItem[];
  truncated: boolean;
  startedAt: number;
  completedAt: number;
};

export type PmThreshold = 1 | 2 | 3 | 4 | 5;

export const PM_THRESHOLDS: readonly PmThreshold[] = [1, 2, 3, 4, 5] as const;

export const PM_THRESHOLD_LABELS: Record<PmThreshold, string> = {
  1: '1 - Every reply',
  2: '2 - Mild and above',
  3: '3 - Notable and above',
  4: '4 - Severe and above',
  5: '5 - Critical only',
};

export function pmThresholdAllowsLevel(threshold: PmThreshold, level: SeverityLevel): boolean {
  return level >= threshold;
}

export const MAX_REPLIES_MIN = 4;
export const MAX_REPLIES_MAX = 10;
export const MAX_REPLIES_DEFAULT = 4
export const PM_THRESHOLD_DEFAULT: PmThreshold = 2;
export const GENERATED_SIGNATURE_DEFAULT = '-Mail Guardian Generated Response';

export type AutoMailSettings = {
  enabled: boolean;
  respondToStates: AutoMailScanState[];
  tonePromptVersion: number;
  staleHours: number;
  autoResolveAfterHours: number;
  maxReplies: number;
  pmModsThreshold: PmThreshold;
  transcriptEnabled: boolean;
  generatedSignature?: string;
  lastScanAt: number;
  updatedAt: number;
};

export const AUTOMAIL_DEFAULT_SETTINGS: AutoMailSettings = {
  enabled: false,
  respondToStates: [],
  tonePromptVersion: 0,
  staleHours: 6,
  autoResolveAfterHours: 24,
  maxReplies: MAX_REPLIES_DEFAULT,
  pmModsThreshold: PM_THRESHOLD_DEFAULT,
  transcriptEnabled: false,
  generatedSignature: GENERATED_SIGNATURE_DEFAULT,
  lastScanAt: 0,
  updatedAt: 0,
};

export type AutoMailConvoState = {
  conversationId: string;
  lastAiReplyAt: string | null;
  awaitingResolutionDeadline: number | null;
  livemodFlagged: boolean;
  resolvedByAi: boolean;
  updatedAt: number;
};

export type AutoMailScanResult = {
  startedAt: number;
  completedAt: number;
  scanned: number;
  replied: number;
  staleNudged: number;
  autoArchived: number;
  skipped: number;
  errors: number;
  notes: string[];
};

export type AutoMailReplyMode =
  | 'continue'
  | 'stale-nudge'
  | 'archive-ack'
  | 'livemod-ack';

export type AutoMailUserShortcut = 'archive' | 'rep' | null;

export type DraftPreflightSource = 'modmail' | 'menu';

export type DraftPreflightVerdict = 'allow' | 'disallow' | 'gray';

export type DraftCandidate = {
  title: string;
  body: string;
};

export type RemovedPostSample = {
  thingId: string;
  kind: 'post' | 'comment';
  titleOrBody: string;
  reason: string;
  removedAtIso: string;
};

export type PostingRequirementKind =
  | 'karma'
  | 'comment_karma'
  | 'link_karma'
  | 'account_age_days'
  | 'post_count'
  | 'comment_count';

export type PostingRequirementSource = 'rules' | 'automod' | 'wiki';

export type PostingRequirement = {
  kind: PostingRequirementKind;
  minimum: number;
  source: PostingRequirementSource;
  raw: string;
};

export type UserSignals = {
  username: string;
  createdAtIso: string | null;
  accountAgeDays: number | null;
  linkKarma: number | null;
  commentKarma: number | null;
  subredditLinkKarma: number | null;
  subredditCommentKarma: number | null;
  recentPostCount: number | null;
  recentCommentCount: number | null;
  recentNegativeCommentCount: number | null;
  hasVerifiedEmail: boolean | null;
  isModerator: boolean | null;
};

export type SubredditPolicyContext = {
  sub: string;
  rulesText: string;
  wikiSummary: string;
  automodSummary: string;
  postingRequirements: PostingRequirement[];
  capabilities: {
    hasRules: boolean;
    hasWiki: boolean;
    hasAutomod: boolean;
  };
};

export type DraftPreflightInput = {
  sub: string;
  source: DraftPreflightSource;
  question: string;
  draftTitle: string;
  draftBody: string;
  username?: string;
};

export type DraftPreflightResult = {
  verdict: DraftPreflightVerdict;
  rationale: string;
  guidance: string;
  templateTitle: string;
  templateBody: string;
  citations: string[];
  bypassRisk: boolean;
  usedModel: string;
  usedProModel: boolean;
};

export type DraftPreflightContext = {
  input: DraftPreflightInput;
  policy: SubredditPolicyContext;
  removedSamples: RemovedPostSample[];
  userSignals: UserSignals | null;
  result: DraftPreflightResult;
};

export type KarmaGateContext = {
  hasConfirmedKarmaGateFailure: boolean;
  failedRequirementKinds: PostingRequirementKind[];
  seedHint?: string;
};

export const AUTOMAIL_REPLY_MAX = 4000;
export const AUTOMAIL_SCAN_CONVO_CAP = 50;
