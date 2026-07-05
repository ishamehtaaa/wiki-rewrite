// Regression corpus for the rewriter. When a rewrite comes out wrong, add the
// input here with checks for what went wrong — then fix rules.js until
// `npm run evals` passes. Don't patch the prompt for one example without a case.
//
// Per case:
//   input     — the draft to rewrite
//   mustKeep  — substrings (facts) that must survive the rewrite
//   maxRatio  — output/input length cap (default 0.7; the prompt targets 0.5).
//               Short, fact-dense inputs may need a looser cap.
//   atMostOf  — { terms, max, label }: at most `max` of `terms` may appear
//               (e.g. redundant endorsements that should be consolidated)
//
// Stance language is asserted automatically: no output may match the STANCE
// vocabulary in rules.js (text inside double/curly quotes is exempt, since
// keeping one substantive quotation is allowed).

export const cases = [
  {
    name: 'dramatized history (siege of Trichinopoly)',
    // Nearly every sentence is a checkable fact, so consolidation can't reach
    // 0.5 — the failure mode being tested is epic narration, not padding.
    // Good runs land at 0.75–0.82 of input; the cap only guards against
    // full-length paraphrase.
    maxRatio: 0.85,
    mustKeep: ['1660', 'Chokkanatha', 'Lingama', 'Shahaji', '12,000', '7,000', 'Gingee'],
    input: `The siege of Trichinopoly in 1660 was a conflict during Chokkanatha Nayak's reign aided by the treacherous general Lingama Nayak, a Bijapuri army led by Shahaji laid siege to the fort with a combined force of 12,000 infantry and 7,000 cavalry. The defenders faced challenges from both the besiegers and conspirators within their ranks. Chokkanatha Nayak's vigilance exposed plots, leading to the execution of traitors and the reorganization of his administration. This swift action turned the tide forcing the retreat of the Bijapuri forces to Gingee.`,
  },
  {
    name: 'promotional company bio',
    maxRatio: 0.6,
    mustKeep: ['Austin', '2012', 'Jane Doe', '300', '2019'],
    input: `Nestled in the heart of Austin, Acme Robotics stands as a world-renowned pioneer in cutting-edge automation. Founded in 2012 by visionary engineer Jane Doe, the company boasts over 300 employees and garnered the prestigious National Robotics Award in 2019. Many believe Acme is a testament to the power of innovation, and experts agree that its impact on the ever-evolving robotics landscape has been nothing short of remarkable. Whether you're a startup founder or an industry veteran, Acme's groundbreaking solutions seamlessly transform how businesses operate.`,
  },
  {
    name: 'reception section with redundant praise',
    maxRatio: 0.6,
    mustKeep: ['1998'],
    // Four reviewers make the same evaluative point; at most two should survive.
    atMostOf: { terms: ['Smith', 'Jones', 'Brown', 'White'], max: 2, label: 'redundant endorsements' },
    input: `Published in 1998, the book was met with universal acclaim from critics around the world. In his review for The Times, John Smith called it “a towering achievement that will echo through the ages.” Writing in The Guardian, Mary Jones described it as “essential reading for anyone who cares about history.” Similarly, the historian Paul Brown hailed it as “a masterpiece of the genre,” while the critic Ann White celebrated its “breathtaking scope and ambition.” It is widely regarded as one of the most influential works of the decade, and its rich tapestry of themes continues to inspire readers worldwide.`,
  },
];
