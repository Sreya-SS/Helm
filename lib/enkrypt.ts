/**
 * Helm — Enkrypt AI guardrail client
 * ----------------------------------------------------------------------------
 * Built against the LIVE Enkrypt docs (docs.enkryptai.com, verified June 2026).
 * This file IS the answer to the doc's open task 9.1 ("verify detectors before
 * writing any trust-score logic — do not assume detector names or outputs").
 *
 * VERIFIED FACTS
 * --------------
 *   • Detect endpoint:  POST https://api.enkryptai.com/guardrails/detect
 *   • Auth header:      apikey: <ENKRYPT_API_KEY>     (NOT "Authorization: Bearer")
 *   • Request body:     { text, detectors: { <name>: { enabled: true } } }
 *   • Response body:    { summary: { <name>: 0|1 }, details: { <name>: {...} } }
 *
 *   Live detectors on /detect:
 *     injection_attack (binary + confidence), toxicity, nsfw, pii,
 *     topic_detector, keyword_detector, policy_violation, bias,
 *     system_prompt_leak
 *
 *   Separate endpoints (take a context/question + an answer):
 *     POST /guardrails/adherence  → adherence_score (binary 0|1)
 *     POST /guardrails/relevancy  → relevancy (binary 0|1)
 *
 * ⚠️ KEY FINDING — this changes the doc's Section 9 / 16.2 design:
 *     The HALLUCINATION detector is marked "Coming soon" in Enkrypt's docs and
 *     is NOT callable. Do not build the trust layer on it. Build it on
 *     ADHERENCE, which is live and does exactly what we need: it checks whether
 *     an answer is supported by a given context. For Helm:
 *         context = source_quote (the verbatim transcript span)
 *         answer  = item.text     (what the agent claims was decided/assigned)
 *     adherence == 0  →  the item is not backed by the transcript  →  quarantine.
 *
 * ✅ VERIFIED via live probe (June 24 2026):
 *   /adherence body: { context, llm_answer }  (NOT "answer" — that 400s)
 *   /relevancy body: { question, llm_answer }
 *   /adherence response: { summary: { adherence_score: 0.0|1.0 },
 *                          details: { atomic_facts, adherence_list, adherence_latency } }
 *   /relevancy response: { summary: { relevancy_score: 0.0|1.0 },
 *                          details: { atomic_facts, relevancy_list, relevancy_latency } }
 *
 * ⚠️ CRITICAL FINDING from probe: adherence is VERY literal. If the context
 *   says "I'll have MongoDB ready" but the item says "Rahul will set up MongoDB",
 *   adherence returns 0 because "Rahul" isn't in the context. FIX: pass a WIDE
 *   transcript chunk (with speaker labels) as context, not just the tight
 *   source_quote. The pipeline must build context as:
 *     "[00:29] Priya: ... [00:41] Rahul: I'll have the MongoDB instance ready by Friday."
 *   so the speaker identity is visible to the adherence detector.
 */

const ENKRYPT_BASE_URL = "https://api.enkryptai.com";

export interface EnkryptConfig {
  apiKey: string;
  baseUrl?: string;
  /** ms before a single request is abandoned. */
  timeoutMs?: number;
}

/** Detector names we actually use in Helm (all verified live). */
export type DetectorName =
  | "injection_attack"
  | "policy_violation"
  | "pii"
  | "toxicity"
  | "nsfw"
  | "topic_detector"
  | "keyword_detector";

export interface DetectResponse {
  summary: Record<string, number>;
  details: Record<string, unknown>;
}

export class EnkryptClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config: EnkryptConfig) {
    if (!config.apiKey) throw new Error("EnkryptClient: ENKRYPT_API_KEY is required");
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? ENKRYPT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.apiKey, // verified: lowercase `apikey`, not Bearer
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Enkrypt ${path} → ${res.status} ${res.statusText}: ${text}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * General detector pass. VERIFIED shape.
   * Example: detect(text, ["injection_attack", "pii"])
   */
  async detect(text: string, detectors: DetectorName[]): Promise<DetectResponse> {
    const detectorBody: Record<string, { enabled: true }> = {};
    for (const d of detectors) detectorBody[d] = { enabled: true };
    return this.post<DetectResponse>("/guardrails/detect", {
      text,
      detectors: detectorBody,
    });
  }

  // -- Checkpoint 1: raw transcript, before any agent sees it -----------------
  /**
   * VERIFIED response shape:
   *   { summary: { injection_attack: 0|1 },
   *     details: { injection_attack: { safe: "0.887", attack: "0.113", ... } } }
   *   Note: confidence values are STRINGS, not numbers.
   */
  async checkInjection(text: string): Promise<{ flagged: boolean; confidence: number }> {
    const r = await this.detect(text, ["injection_attack"]);
    const flagged = (r.summary?.injection_attack ?? 0) === 1;
    const detail = (r.details?.injection_attack ?? {}) as Record<string, string>;
    const confidence = parseFloat(detail.attack) || (flagged ? 1 : 0);
    return { flagged, confidence };
  }

  // -- Checkpoint 2: every extracted item, before it is written ---------------
  /**
   * Adherence: is `llmAnswer` supported by `context`?
   *
   * VERIFIED field names: { context, llm_answer }
   * VERIFIED response:    { summary: { adherence_score: 0.0 | 1.0 } }
   *
   * IMPORTANT: `context` must be a WIDE transcript chunk with speaker labels,
   * not just the tight source_quote. Otherwise the detector can't see who
   * said what and will reject even truthful items (see header comment).
   */
  async checkAdherence(context: string, llmAnswer: string): Promise<{ adherent: boolean }> {
    const r = await this.post<{ summary: { adherence_score: number } }>(
      "/guardrails/adherence",
      { context, llm_answer: llmAnswer }
    );
    return { adherent: r.summary.adherence_score === 1.0 };
  }

  /**
   * Relevancy: does `llmAnswer` address `question`?
   * VERIFIED field names: { question, llm_answer }
   * VERIFIED response:    { summary: { relevancy_score: 0.0 | 1.0 } }
   */
  async checkRelevancy(question: string, llmAnswer: string): Promise<{ relevant: boolean }> {
    const r = await this.post<{ summary: { relevancy_score: number } }>(
      "/guardrails/relevancy",
      { question, llm_answer: llmAnswer }
    );
    return { relevant: r.summary.relevancy_score === 1.0 };
  }

  // -- Checkpoint 3: drafted follow-up, before it enters the approval queue ----
  /** Policy/topic gate on a drafted nudge. Returns true if the draft is OK to queue. */
  async checkPolicy(text: string): Promise<{ allowed: boolean }> {
    const r = await this.detect(text, ["policy_violation"]);
    return { allowed: (r.summary?.policy_violation ?? 0) === 0 };
  }
}

// ---------------------------------------------------------------------------
// Trust score — composed from the detectors that ACTUALLY EXIST.
// ---------------------------------------------------------------------------
// The doc (16.2) assumed a single Enkrypt confidence per item. Reality: the
// useful detectors are mostly BINARY (adherence 0/1, relevancy 0/1, policy
// 0/1), and injection returns a confidence. So the trust score is a small
// composite, not one number from one call. This keeps the visible trust badge
// honest and the tiers explainable.
//
// Tiers (doc 16.2, recalibrated to real outputs):
//   adherence == false              → 0.0  → quarantined (item not in transcript)
//   injection flagged on the source → cap at 0.40 (tainted context)
//   adherent + relevant             → ~0.90 → auto-commit (green)
//   adherent but not relevant        → ~0.70 → pending_review (amber)

export interface TrustInputs {
  adherent: boolean;
  relevant: boolean;
  injectionFlagged: boolean;
  /** optional self-confidence the model emitted; nudges within a tier only. */
  selfConfidence?: number;
}

export function computeTrustScore(t: TrustInputs): number {
  if (!t.adherent) return 0.0; // hard fail — not supported by the transcript
  let score = t.relevant ? 0.9 : 0.7;
  if (t.injectionFlagged) score = Math.min(score, 0.4);
  if (typeof t.selfConfidence === "number") {
    // small ±0.05 nudge, clamped so it can't cross a tier boundary on its own
    score += (t.selfConfidence - 0.5) * 0.1;
  }
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

export function reviewStateForScore(score: number): "auto" | "pending_review" | "quarantined" {
  if (score >= 0.85) return "auto";
  if (score >= 0.6) return "pending_review";
  return "quarantined";
}
