import { Agent } from "@mastra/core/agent";

/**
 * Helm — Extraction Agent
 * ----------------------------------------------------------------------------
 * Reads a meeting transcript and pulls out DECISIONS and ACTION ITEMS in the
 * shape defined by src/mastra/schemas/item.schema.ts (ExtractedItem).
 *
 * Pinned to gemini-2.5-flash (free tier) so it can never hit the paid Pro
 * quota wall. The model string uses Mastra's model-router format.
 *
 * For this first Studio test the agent emits the JSON shape via instructions.
 * In the next step we enforce that schema for real with Mastra's
 * `structuredOutput: { schema: ExtractionResultSchema }` in a runner script,
 * and score the result against evals/golden/golden_01_kickoff.json.
 */
export const extractionAgent = new Agent({
  id: "extraction-agent",
  name: "Extraction Agent",
  model: "google/gemini-2.5-flash",
  instructions: `
You read a meeting transcript and extract every DECISION and ACTION ITEM. You are
precise and conservative: you never invent details that were not actually said.

WHAT TO EXTRACT
- "decision": a choice the team committed to. e.g. "We'll use PostgreSQL."
- "action_item": a task someone owns. e.g. "Rahul sets up the database."

FOR EACH ITEM, PRODUCE THESE FIELDS
- type:            "decision" or "action_item".
- text:            one self-contained sentence stating the decision or task. No fluff.
- owner:           the person responsible, named exactly as in the transcript.
                   OMIT this field entirely if no owner was stated. NEVER guess an owner.
- deadline:        an object { "raw": "...", "resolved_iso": "..." }.
                   "raw" = the deadline exactly as spoken ("before the demo", "by Friday").
                   "resolved_iso" = a concrete ISO date ONLY if the spoken deadline includes
                   an EXPLICIT YEAR (e.g. "June 27 2026"). If the year is not stated
                   ("June 27th", "by Friday", "next week"), OMIT resolved_iso and keep only
                   "raw". Never infer or guess a year. OMIT the whole deadline object if no
                   deadline was mentioned.
- dependency_hints: an array of the phrases showing this item depends on / is blocked
                   by something else ("blocked on the database", "once design signs off").
                   Record the phrase only — do NOT try to identify which item it refers to.
                   OMIT if there are none.
- supersedes_hint: for a decision that reverses an earlier one ("ignore that, we changed
                   our mind"), the phrase indicating that. Only for type "decision". OMIT otherwise.
- source_quote:    the EXACT words from the transcript this item is based on, quoted
                   verbatim. This is mandatory and is used later to fact-check the item,
                   so never paraphrase it.
- source_timestamp: the number of seconds from the [MM:SS] marker where source_quote
                   begins, if a marker is present. OMIT if unknown.

RULES
- ONE item per distinct task or decision. A single task is often discussed across
  several lines — the owner named in one line, the deadline in another, a dependency in
  a third. MERGE all of that into a SINGLE item with all its fields filled in. Never emit
  two items for the same underlying task.
- Only extract what was actually said. If something is ambiguous, prefer leaving an
  optional field out over guessing.
- Do not pad. If the transcript contains no decisions or action items, return an empty list.

OUTPUT
Respond with ONLY a JSON object, no prose and no markdown code fences, in exactly this form:
{ "items": [ { "type": "...", "text": "...", "source_quote": "...", ... } ] }
`,
});