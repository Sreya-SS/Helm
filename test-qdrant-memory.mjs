// test-qdrant-memory.mjs
// ---------------------------------------------------------------------------
// Helm memory pipeline: embed extracted items → store in Qdrant → query across
// meetings. This proves the "why did we switch databases?" demo moment.
//
// Run:  node --env-file=.env test-qdrant-memory.mjs
// ---------------------------------------------------------------------------

import { QdrantVector } from "@mastra/qdrant";
import { google } from "@ai-sdk/google";
import { embed, embedMany } from "ai";

// -- Config --
const COLLECTION = "meeting_items";
let COLLECTION_ACTUAL = COLLECTION; // may get a timestamp suffix if deletion is still propagating
// text-embedding-004 was shut down Jan 14, 2026. Current model: gemini-embedding-001.
// IMPORTANT: dimension changed from 768 → 3072 with this model.
const DIMENSION = 3072;

const qdrant = new QdrantVector({
  id: "helm-qdrant",
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY,
  https: true,
});

const embeddingModel = google.textEmbeddingModel("gemini-embedding-001");

// -- Items from BOTH transcripts (the agent's real output) --
// Each has a meeting_id so we can trace which meeting it came from.

const items = [
  // === Meeting 1: Kickoff ===
  {
    meeting_id: "meeting_01_kickoff",
    meeting_title: "Helm Dashboard Kickoff — June 22",
    type: "decision",
    text: "The team will use MongoDB for the first cut.",
    owner: null,
    source_quote: "Decision: we'll use MongoDB for the first cut.",
  },
  {
    meeting_id: "meeting_01_kickoff",
    meeting_title: "Helm Dashboard Kickoff — June 22",
    type: "action_item",
    text: "Rahul will stand up the MongoDB instance and the base collections by Friday.",
    owner: "Rahul",
    source_quote: "I'll have the MongoDB instance and the base collections ready by Friday.",
  },
  {
    meeting_id: "meeting_01_kickoff",
    meeting_title: "Helm Dashboard Kickoff — June 22",
    type: "action_item",
    text: "Sreya will build the dashboard UI, targeting the UI shell by June 27th. Blocked on Rahul's database.",
    owner: "Sreya",
    source_quote: "Sreya owns the dashboard UI, depends on the database being ready. Let's target the UI shell by June 27th.",
  },
  {
    meeting_id: "meeting_01_kickoff",
    meeting_title: "Helm Dashboard Kickoff — June 22",
    type: "action_item",
    text: "Ananya will draft the deployment plan before the demo.",
    owner: "Ananya",
    source_quote: "Ananya, can you also draft the deployment plan before the demo?",
  },

  // === Meeting 2: Standup (reverses the DB decision) ===
  {
    meeting_id: "meeting_02_standup",
    meeting_title: "Standup — June 25",
    type: "decision",
    text: "The team is moving from MongoDB to PostgreSQL because the data is relational. The earlier MongoDB decision is superseded.",
    owner: null,
    supersedes_hint: "Ignore the earlier MongoDB call.",
    source_quote: "Decision: we're moving from MongoDB to PostgreSQL because the data is relational. Ignore the earlier MongoDB call.",
  },
  {
    meeting_id: "meeting_02_standup",
    meeting_title: "Standup — June 25",
    type: "action_item",
    text: "Rahul will have Postgres set up by Wednesday.",
    owner: "Rahul",
    source_quote: "I'll have Postgres set up by Wednesday.",
  },
];

// ---------------------------------------------------------------------------
// Step 1: Create collection (idempotent — skips if it already exists)
// ---------------------------------------------------------------------------
async function setupCollection() {
  console.log("📦 Setting up Qdrant collection...");

  try {
    await qdrant.deleteIndex(COLLECTION);
    console.log(`   Delete requested for '${COLLECTION}'...`);
  } catch {
    console.log(`   '${COLLECTION}' didn't exist yet — nothing to delete.`);
  }

  // Qdrant Cloud's delete is not instantaneous — poll until it's actually gone
  // (or until we give up and fall back to a fresh collection name).
  let gone = false;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const existing = await qdrant.listIndexes();
      if (!existing.includes(COLLECTION)) {
        gone = true;
        break;
      }
    } catch {
      gone = true; // listIndexes failing usually means nothing exists yet
      break;
    }
  }

  if (!gone) {
    console.log(`   ⚠️  Deletion still propagating — using a fresh collection name instead.`);
    // Avoids fighting Qdrant's eventual consistency: just don't reuse the name.
    COLLECTION_ACTUAL = `${COLLECTION}_${Date.now()}`;
  } else {
    COLLECTION_ACTUAL = COLLECTION;
  }

  await qdrant.createIndex({
    indexName: COLLECTION_ACTUAL,
    dimension: DIMENSION,
    metric: "cosine",
  });
  console.log(`   ✅ Collection '${COLLECTION_ACTUAL}' created (${DIMENSION}d, cosine)\n`);
}

// ---------------------------------------------------------------------------
// Step 2: Embed and store all items
// ---------------------------------------------------------------------------
async function storeItems() {
  console.log("🧠 Embedding and storing items...");

  // Build the text strings we'll embed — include type + owner for richer semantics
  const textsToEmbed = items.map(
    (it) =>
      `[${it.type}] ${it.text}${it.owner ? ` (owner: ${it.owner})` : ""}`
  );

  const { embeddings } = await embedMany({
    model: embeddingModel,
    values: textsToEmbed,
  });

  // Build metadata payloads (everything except the embedding itself)
  const metadata = items.map((it) => ({
    text: it.text,
    type: it.type,
    meeting_id: it.meeting_id,
    meeting_title: it.meeting_title,
    owner: it.owner || "unassigned",
    source_quote: it.source_quote,
    supersedes_hint: it.supersedes_hint || "",
  }));

  await qdrant.upsert({
    indexName: COLLECTION_ACTUAL,
    vectors: embeddings,
    metadata,
  });

  console.log(`   ✅ Stored ${items.length} items across 2 meetings\n`);
}

// ---------------------------------------------------------------------------
// Step 3: Cross-meeting query — "why did we switch databases?"
// ---------------------------------------------------------------------------
async function queryMemory(question) {
  console.log(`🔍 Query: "${question}"`);

  const { embedding } = await embed({
    model: embeddingModel,
    value: question,
  });

  const results = await qdrant.query({
    indexName: COLLECTION_ACTUAL,
    queryVector: embedding,
    topK: 5,
  });

  console.log(`   Found ${results.length} results:\n`);

  for (const r of results) {
    const m = r.metadata;
    const score = r.score.toFixed(3);
    const icon = m.type === "decision" ? "📌" : "📋";
    console.log(`   ${icon} [${score}] ${m.text}`);
    console.log(`      Meeting: ${m.meeting_title}`);
    console.log(`      Source: "${m.source_quote}"`);
    if (m.supersedes_hint) {
      console.log(`      ⚠️  Supersedes: ${m.supersedes_hint}`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Run it
// ---------------------------------------------------------------------------
console.log("═══════════════════════════════════════════════════════════");
console.log("  HELM QDRANT MEMORY — cross-meeting query demo");
console.log("═══════════════════════════════════════════════════════════\n");

await setupCollection();
await storeItems();

// The demo question — spans both meetings
await queryMemory("why did the team switch databases?");

// Bonus: a person-specific query
await queryMemory("what is Sreya responsible for?");

// Bonus: a dependency query
await queryMemory("what tasks are blocked?");

console.log("═══════════════════════════════════════════════════════════");
console.log("  If the PostgreSQL decision ranked highest for the DB");
console.log("  switch question, with its supersedes_hint visible —");
console.log("  your cross-meeting memory works. 🎯");
console.log("═══════════════════════════════════════════════════════════");
