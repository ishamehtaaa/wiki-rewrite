// The two-pass rewrite pipeline, shared verbatim by the browser app (app.js)
// and the eval harness (evals/run.js) so evals exercise the exact code the
// app runs. Environment-agnostic: no fs, no DOM — the Claude transport is
// injected as `callClaude(system, user, onDelta?) -> Promise<string>`.

import { SYS, CRITIC_SYS } from '../rules.js';

export const MODEL = 'claude-sonnet-5';

// The critic replies with exactly "PASS" when the draft needs no correction;
// anything longer is the corrected text.
export const criticPassed = review => /^PASS\b/.test(review) && review.length < 10;

// Runs rewrite then critic review. Callbacks may throw to abort (the browser
// uses this to cancel a stale run before paying for the second call).
//   onDraftDelta(partial) — streaming progress on the first pass
//   onDraft(draft)        — first pass complete, review beginning
export async function runPipeline(text, callClaude, { onDraftDelta, onDraft } = {}) {
  const draft = (await callClaude(SYS, 'Text:\n' + text, onDraftDelta)).trim();
  if (onDraft) onDraft(draft);
  const review = (await callClaude(CRITIC_SYS, 'Original:\n' + text + '\n\nRewrite:\n' + draft)).trim();
  const passed = criticPassed(review);
  return { final: passed ? draft : review, draft, review, criticRevised: !passed };
}
