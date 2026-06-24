// test-enkrypt.mjs  (v2 — corrected field names)
// Run:  node --env-file=.env test-enkrypt.mjs

const API_KEY = process.env.ENKRYPT_API_KEY;
const BASE = "https://api.enkryptai.com";

if (!API_KEY) {
  console.error("❌ No ENKRYPT_API_KEY in .env");
  process.exit(1);
}

async function call(label, path, body) {
  try {
    const res = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: API_KEY },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\n=== ${label} → HTTP ${res.status} ===`);
    console.log(text);
  } catch (err) {
    console.log(`\n=== ${label} → FAILED ===`);
    console.log(String(err));
  }
}

// --- Adherence: the trust-score core ---
// Field name fix: "llm_answer" not "answer" (from Python SDK docs)

await call("adherence (truthful)", "/guardrails/adherence", {
  context: "I'll have the MongoDB instance and the base collections ready by Friday.",
  llm_answer: "Rahul will set up the MongoDB instance by Friday.",
});

await call("adherence (fabricated)", "/guardrails/adherence", {
  context: "I'll have the MongoDB instance and the base collections ready by Friday.",
  llm_answer: "Rahul promised to migrate everything to AWS by Monday.",
});

// --- Relevancy ---
await call("relevancy (on-topic)", "/guardrails/relevancy", {
  question: "What database will the team use?",
  llm_answer: "The team decided to use MongoDB for the first cut.",
});

await call("relevancy (off-topic)", "/guardrails/relevancy", {
  question: "What database will the team use?",
  llm_answer: "The weather in Chennai is hot today.",
});

console.log("\n✅ Done. Paste the whole output back.");
