# Hands research case

`evals/cases/rl-research.json` is the reproducible task, seed-source packet and acceptance rubric for the user's second case. It is **input to Hands**, not a completed user deliverable. The supplied short primary-source notes were checked on 2026-09-19, with particular attention to recent agent credit assignment and reward validity.

## Run contract

Give Hands the raw task plus the fixture's scope and source packet. The research agent must inspect original sources, perform a bounded newer-work search, write the report and evidence ledger, and read back its output. Return the artifact manifest, deterministic validation and citation audit to Jev in one batch. Jev should choose `open_artifact`, `repair_evidence`, `repair_coverage` or `escalate_reasoning`. Run the selected action and record its observed result. A research completion counts only if this sequence is visible in the actual Hands trace.

Use Luna for an initial research/synthesis pass. Escalate unresolved synthesis or contradictory evidence to Astra at low effort. Gemini may check the rendered layout. Record the real model and provider for each call; Vertex is the Gemini backend. Do not add another LLM family. A manual evaluator can verify claims independently, but must not silently rewrite the final report and then call the run successful.

## Evidence traps to test

- A paper's revision date is not its first publication date. DeepSeek-R1 is first released in January 2025, even though its current arXiv revision is January 2026. DreamerV3's Nature article is 2025 and its first preprint is 2023.
- DAPO is an ambiguous acronym. The LLM RL paper is arXiv `2503.14476`.
- HiPER's current primary metadata reports ICML 2026. The August SkillGate, FACA and EFCA papers are preprints unless later acceptance is separately verified.
- SkillGate reports a bounded skill-slate result, and FACA's user-feedback gain is concentrated in Telecom. Neither is a measured Hands improvement.
- The AReaL2.0 source makes a systems argument. Keep that argument distinct from empirical results, and distinguish prompt/recipe adaptation from policy-weight reinforcement learning.
- More reward is not evidence of a better artifact. Audit saved content, citations and rendered output independently of the generating model or Jev's confidence.

## Hill-climb measurements

Record end-to-end elapsed time, research and artifact agent calls, Jev request count and latency, public-source fetch count and failure rate, artifact writes, repairs, model escalations and the complete hard-failure checklist. Keep discovery time separate from synthesis and rendering. Cache public source reads by URL/version within a run so repeated checks do not refetch unchanged papers. A cache hit still needs source provenance.

Compare a broad single-agent loop with the bounded source/claim-ledger handoff. Use the same requested output and the same independent audit. Faster generation is an improvement only if citation accuracy, date/status precision and thematic coverage remain intact. The report should propose three held-out Hands experiments; those proposals are hypotheses, not experiments already performed.

## Current outcome

Preparation only. No Hands run or user-facing research report has been produced by this case owner. The root runner owns execution and records its run path; this file must not be counted toward the user's four-of-five completion target.
