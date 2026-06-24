/**
 * Helm — shared Item schema (THE single source of truth)
 * ----------------------------------------------------------------------------
 * The doc's #1 rule (Section 13): "Lock the Zod schema by day 3. Everything
 * downstream — Qdrant payloads, dashboard cards, the Enkrypt adherence check —
 * depends on this shape." So this is built first.
 *
 * Two distinct shapes live here on purpose:
 *
 *   ExtractedItem  — what the EXTRACTION AGENT is allowed to produce. It contains
 *                    ONLY things the model can legitimately read off the transcript.
 *                    It must NOT invent ids, trust scores, embeddings, or resolved
 *                    dependency links — those are the pipeline's job, not the LLM's.
 *
 *   Item           — the STORED entity. ExtractedItem + everything the pipeline
 *                    assigns (ids, resolved depends_on, trust_score, review_state).
 *
 * Design choice (doc 16.8): most fields are OPTIONAL by design. Over-constraining
 * forces the model to hallucinate values just to pass validation. A looser schema
 * + the Enkrypt adherence gate is what actually reduces hallucination.
 *
 * Works with Zod v3 (^3.25) or v4 — Mastra requires one of these. Avoids
 * v4-only / v3-only syntax (e.g. no `z.record` single-arg form).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ItemType = z.enum(["decision", "action_item"]);
export type ItemType = z.infer<typeof ItemType>;

export const ItemStatus = z.enum([
  "open",
  "in_progress",
  "at_risk",
  "blocked",
  "done",
]);
export type ItemStatus = z.infer<typeof ItemStatus>;

/**
 * review_state mirrors the trust tiers in doc 16.2:
 *   auto           → high trust, committed straight to the dashboard
 *   pending_review → medium trust, written but amber-flagged, no follow-ups
 *   quarantined    → low trust / failed adherence, kept off the main dashboard
 */
export const ReviewState = z.enum(["auto", "pending_review", "quarantined"]);
export type ReviewState = z.infer<typeof ReviewState>;

// ---------------------------------------------------------------------------
// Deadline — free speech says "by Friday" or "before the demo", not ISO dates.
// Always keep the raw phrase; resolve to ISO best-effort (doc 16.7).
// ---------------------------------------------------------------------------

export const DeadlineSchema = z
  .object({
    raw: z
      .string()
      .describe(
        "The deadline exactly as spoken, e.g. 'before the demo', 'next Friday', 'June 28'."
      ),
    resolved_iso: z
      .string()
      .optional()
      .describe(
        "Best-effort ISO 8601 date if the raw phrase can be resolved against the meeting date. Leave empty if genuinely ambiguous — do not guess."
      ),
  })
  .describe("A deadline mentioned in the meeting. Omit entirely if none was stated.");

export type Deadline = z.infer<typeof DeadlineSchema>;

// ---------------------------------------------------------------------------
// ExtractedItem — the contract for the extraction agent's structured output.
// Every .describe() doubles as the prompt the model sees (Mastra/Vercel AI SDK
// surface field descriptions to the model), so they are written as instructions.
// ---------------------------------------------------------------------------

export const ExtractedItemSchema = z.object({
  type: ItemType.describe(
    "'decision' = a choice the team committed to (e.g. 'we'll use PostgreSQL'). 'action_item' = a task someone owns (e.g. 'Rahul configures the DB')."
  ),

  text: z
    .string()
    .min(1)
    .describe(
      "A single, self-contained sentence stating the decision or task. No fluff, no preamble."
    ),

  owner: z
    .string()
    .optional()
    .describe(
      "The person responsible, as named in the meeting. Use the name spoken. Omit if no owner was stated — DO NOT assign one yourself."
    ),

  deadline: DeadlineSchema.optional(),

  /**
   * Dependency LANGUAGE, not resolved links. The agent records the phrase it
   * heard ("blocked by the auth work", "once design signs off"); the
   * dependencyResolver tool later runs a project-scoped Qdrant search to turn
   * each hint into a real item id. The agent must never guess an item id.
   */
  dependency_hints: z
    .array(z.string())
    .optional()
    .describe(
      "Natural-language mentions that this item depends on / is blocked by something else. Record the phrase exactly; do not try to identify which existing item it refers to."
    ),

  /**
   * For decisions that reverse an earlier one ("ignore that, we changed our
   * mind"). Again a hint, resolved to supersedes_id later via Qdrant.
   */
  supersedes_hint: z
    .string()
    .optional()
    .describe(
      "If this decision overturns or replaces an earlier decision, the phrase indicating that. Only for type='decision'."
    ),

  /**
   * THE field the Enkrypt adherence check runs against. The verbatim transcript
   * span this item was derived from becomes the 'context'; `text` is the
   * 'answer'. If adherence(context=source_quote, answer=text) is low, the item
   * was not actually supported by what was said → quarantine.
   */
  source_quote: z
    .string()
    .min(1)
    .describe(
      "The exact words from the transcript that this item is based on, quoted verbatim. This is what the item will be fact-checked against — never paraphrase here."
    ),

  source_timestamp: z
    .number()
    .optional()
    .describe("Seconds from the start of the recording where source_quote begins, if known."),
});

export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;

/** The full structured output the extraction agent returns for one transcript. */
export const ExtractionResultSchema = z
  .object({
    items: z
      .array(ExtractedItemSchema)
      .describe("Every decision and action item found. Empty array if none — do not pad."),
  })
  .describe("Structured extraction result for a single meeting transcript.");

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// ---------------------------------------------------------------------------
// Item — the stored entity. ExtractedItem + pipeline-assigned fields.
// ---------------------------------------------------------------------------

export const ItemSchema = ExtractedItemSchema.extend({
  id: z.string().describe("Helm-assigned unique id."),
  meeting_id: z.string(),
  project_id: z.string().describe("Inherited from the meeting's workspace (doc 16.1)."),

  status: ItemStatus.default("open"),

  /** Resolved dependency item ids (from dependency_hints via Qdrant). */
  depends_on: z.array(z.string()).default([]),

  /** Resolved superseded decision id (from supersedes_hint via Qdrant). */
  supersedes_id: z.string().optional(),

  /** 0..1 composite from the Enkrypt checks — see server/lib/enkrypt.ts. */
  trust_score: z.number().min(0).max(1),

  review_state: ReviewState.default("auto"),

  embedding_id: z.string().optional().describe("Qdrant point id for this item's vector."),

  followup_sent_at: z.string().optional(),
  completed_after_followup: z.boolean().default(false),

  created_at: z.string(),
});

export type Item = z.infer<typeof ItemSchema>;

// ---------------------------------------------------------------------------
// Dependency cycle guard (doc 16.8)
// ---------------------------------------------------------------------------
// Zod's shape validation cannot catch cycles (A depends_on B depends_on A).
// A circular dependency would make the risk monitor loop forever. Run this
// graph-integrity pass on the resolved depends_on edges BEFORE storing, and
// drop / flag any edge that closes a cycle.
//
// Returns the first cycle found as an ordered list of ids, or null if the
// graph is acyclic. Standard DFS three-colour algorithm.

type DependencyNode = { id: string; depends_on: string[] };

export function findDependencyCycle(items: DependencyNode[]): string[] | null {
  const edges = new Map<string, string[]>();
  for (const it of items) edges.set(it.id, it.depends_on ?? []);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const id of edges.keys()) colour.set(id, WHITE);

  const path: string[] = [];

  function visit(node: string): string[] | null {
    colour.set(node, GRAY);
    path.push(node);

    for (const next of edges.get(node) ?? []) {
      // Edge can point to an item not in this batch (already stored). Skip
      // unknowns rather than treating them as a cycle.
      if (!edges.has(next)) continue;

      const c = colour.get(next);
      if (c === GRAY) {
        // Found a back-edge → cycle. Slice the path from where `next` first appeared.
        const start = path.indexOf(next);
        return [...path.slice(start), next];
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }

    path.pop();
    colour.set(node, BLACK);
    return null;
  }

  for (const id of edges.keys()) {
    if (colour.get(id) === WHITE) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}
