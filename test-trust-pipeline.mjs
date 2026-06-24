// test-trust-pipeline.mjs
// ---------------------------------------------------------------------------
// The "catch the fabricated item" demo moment.
//
// Takes real extracted items from transcript 1 + one planted fake,
// runs each through Enkrypt adherence + relevancy, computes trust scores,
// and shows the verdict (auto / pending_review / quarantined).
//
// Run:  node --env-file=.env test-trust-pipeline.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";

const API_KEY = process.env.ENKRYPT_API_KEY;
const BASE = "https://api.enkryptai.com";

if (!API_KEY) {
  console.error("❌ No ENKRYPT_API_KEY in .env");
  process.exit(1);
}

// -- Load the full transcript as wide context for adherence --
const transcript = readFileSync("evals/sampleTranscripts/transcript_01_kickoff.txt", "utf-8");

// -- Real items (from your extraction agent's actual output) + one FAKE --
const items = [
  {
    label: "REAL — MongoDB decision",
    text: "The team will use MongoDB for the first cut.",
    source_quote: "Decision: we'll use MongoDB for the first cut.",
  },
  {
    label: "REAL — Rahul's database task",
    text: "Rahul will stand up the MongoDB instance and the base collections.",
    source_quote: "[00:29] Priya: Fine for now. Decision: we'll use MongoDB for the first cut. Rahul, can you stand up the database this week?\n[00:41] Rahul: Yeah, I'll have the MongoDB instance and the base collections ready by Friday.",
  },
  {
    label: "REAL — Sreya's dashboard UI",
    text: "Sreya will take the dashboard UI and target the UI shell.",
    source_quote: "[01:03] Sreya: I'll take the dashboard UI. But heads up — I can't wire the live data until Rahul's database is actually up, so my work is blocked on his.\n[01:18] Priya: Noted. Sreya owns the dashboard UI, depends on the database being ready. Let's target the UI shell by June 27th.",
  },
  {
    label: "REAL — Ananya's deployment plan",
    text: "Ananya will draft the deployment plan.",
    source_quote: "[01:52] Priya: Last thing — Ananya, can you also draft the deployment plan before the demo?\n[02:04] Ananya: Sure, deployment plan before the demo.",
  },
  // ⬇️ THIS ONE IS FAKE — nobody said this in the meeting
  {
    label: "🚨 FAKE — fabricated commitment",
    text: "Rahul promised to migrate the entire infrastructure to AWS by next Monday.",
    source_quote: "Rahul promised to migrate the entire infrastructure to AWS by next Monday.",
  },
];

// -- Enkrypt helpers --
async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function checkAdherence(context, llmAnswer) {
  const r = await post("/guardrails/adherence", { context, llm_answer: llmAnswer });
  return r.summary.adherence_score === 1.0;
}

async function checkRelevancy(question, llmAnswer) {
  const r = await post("/guardrails/relevancy", { question, llm_answer: llmAnswer });
  return r.summary.relevancy_score === 1.0;
}

function computeTrustScore(adherent, relevant) {
  if (!adherent) return 0.0;
  return relevant ? 0.9 : 0.7;
}

function reviewState(score) {
  if (score >= 0.85) return "✅ auto (green — goes to dashboard)";
  if (score >= 0.6) return "🟡 pending_review (amber — needs human)";
  return "🔴 quarantined (blocked — never reaches dashboard)";
}

// -- Run the pipeline --
console.log("═══════════════════════════════════════════════════════════");
console.log("  HELM TRUST PIPELINE — catch the fabricated item");
console.log("═══════════════════════════════════════════════════════════\n");

// The relevancy question is always "what was discussed in this meeting?"
// because we're checking if the item is relevant to the meeting's content.
const relevancyQuestion = "What decisions and action items were discussed in this project meeting about the dashboard?";

for (const item of items) {
  console.log(`--- ${item.label} ---`);
  console.log(`  Text: "${item.text}"`);

  try {
    // Adherence: use the FULL transcript as wide context (the key finding).
    // For the fake item, its source_quote won't be in the transcript, so
    // adherence will fail regardless — but we use the full transcript to be
    // consistent with how the real pipeline will work.
    const adherent = await checkAdherence(transcript, item.text);

    // Relevancy: is this item relevant to the meeting's topic?
    const relevant = await checkRelevancy(relevancyQuestion, item.text);

    const score = computeTrustScore(adherent, relevant);
    const state = reviewState(score);

    console.log(`  Adherent: ${adherent}  |  Relevant: ${relevant}`);
    console.log(`  Trust score: ${score}`);
    console.log(`  Verdict: ${state}`);
  } catch (err) {
    console.log(`  ⚠️ Error: ${err.message}`);
  }

  console.log();

  // Small delay to be kind to free-tier rate limits
  await new Promise((r) => setTimeout(r, 1500));
}

console.log("═══════════════════════════════════════════════════════════");
console.log("  If the fake item got quarantined and the real ones");
console.log("  got auto/review — your trust pipeline works. 🎯");
console.log("═══════════════════════════════════════════════════════════");
