# Mail Guardian

Mail Guardian is a moderator-scoped triage foundation for Reddit Mod Mail. It is designed around one priority: do not miss high-risk conversations when queue pressure, ambiguity, and timing uncertainty are highest.

Rather than framing moderation as a single classifier decision, Mail Guardian treats each thread as an operational workflow: severity estimation, policy-aware reply drafting, conservative escalation, and bounded automation with human handoff.

## Foundation

The system was developed and evaluated in a multi-subreddit simulated environment grounded in real Reddit language and behavior patterns. The central design objective is high-recall moderator paging under uncertainty.

Core philosophy:

- Safety-first recall for severe scenarios
- Policy-aware behavior for routine scenarios
- Transparent tradeoff toward over-escalation instead of missed escalation
- Human moderator authority preserved as final decision-maker

## Research Snapshot

Full paper: [High-Recall Moderator Paging in LLM-Assisted Reddit Triage](./high-recall-moderator-paging-in-llm-assisted-reddit-triage.pdf)

Evaluation corpus: 2,461 moderation scenarios (CSV-backed)

Model roles used in study conditions:

- Gemini Flash 2.5 for severity analysis
- Gemini Flash 3 for response generation

Strict paging-positive definition required all three signals:

- `pm_should_pm = true`
- `flag_for_livemod` present
- severe rationale in context

Observed outcomes under that strict definition:

- Paging recall: 1.00 (TP = 232, FN = 0)
- Precision: 0.236 (FP = 751)
- Threshold compliance among true-positive PM cases: 90.5% (210/232)

Interpretation: the operating point is intentionally conservative. The system favors avoiding missed escalation at the cost of additional moderator review load.

## How Mail Guardian Behaves

Mail Guardian is not a "set and forget" autoresponder. It is a triage engine with explicit safeguards.

- Drafts first-touch replies in subreddit tone
- Scores severity and triage category for each conversation
- Escalates moderators via private modmail paging when configured thresholds are met
- Allows serious-case override behavior in extreme contexts where strict thresholding would under-escalate
- Caps AI reply loops and hands off to moderators after bounded turns
- Adds stale-thread nudges and auto-archive timing controls
- Posts structured internal reports and evidence summaries for moderator context

## Distress and Harm Safeguards

When messages indicate distress, self-harm risk, or other severe harm vectors, Mail Guardian is designed to pivot from routine support language to safety-oriented escalation behavior.

- Automatically includes explicit support or hotline-style guidance in self-harm/distress contexts
- Escalates moderators conservatively when severe cues are present
- Treats missed escalation as the primary failure mode to avoid

In the evaluated self-harm scenarios that were paged, support-resource guidance appeared in 100.0% of cases (33/33).

## Operational Constraints

- Moderator-scoped Reddit permissions only
- Per-moderator API key storage and rotation
- In-Reddit execution model (no external dashboard requirement)
- Internal command shortcuts for moderators (`-rep`, `-archive`)
- Internal conversations are not auto-replied by default; moderator commands are explicit

## Tradeoffs

Mail Guardian is tuned for recall, not minimal paging volume.

- Strength: strong protection against missed severe escalation
- Cost: higher false-positive paging volume and moderator load in borderline cases

This is an intentional moderation stance: bias toward human review when ambiguity intersects with potential harm.

## Privacy and Data Handling

- API keys are stored in Reddit private storage, scoped by subreddit and moderator
- Keys are not re-displayed after save and are not logged
- Mod-only artifacts (summaries, transcripts, internal notes) remain moderator-visible
- Outbound model traffic is limited to Gemini endpoints

## Credits
fsvreddit's repos were very helpful to see what we could work with
[MOD]u/llamageddon01 of reddit had wonderful posts we could reference to help new redditors!

## License

This project is licensed under the GNU General Public License v3.0 only (GPL-3.0-only).