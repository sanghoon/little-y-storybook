#!/usr/bin/env node
import "dotenv/config";
import { Client } from "langsmith/client";

const parseArg = (name, fallback) => {
  const index = process.argv.findIndex((arg) => arg === name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
};

const traceId = parseArg("--trace", "");
const projectName = parseArg(
  "--project",
  process.env.LANGSMITH_PROJECT || "little-y-storybook"
);
const apiKey = parseArg("--api-key", process.env.LANGSMITH_API_KEY || "");
const apiUrl = parseArg("--endpoint", process.env.LANGSMITH_ENDPOINT || "");

const toArray = async (iter, max) => {
  const items = [];
  for await (const item of iter) {
    items.push(item);
    if (items.length >= max) break;
  }
  return items;
};

const stripFences = (text) => {
  const source = String(text ?? "").trim();
  const fenceMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return source.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
};

const normalizeJsonLike = (text) => {
  const cleaned = stripFences(text);
  const match = cleaned.match(/\{[\s\S]*\}/) || cleaned.match(/\[[\s\S]*\]/);
  if (!match) return "";
  const sanitized = match[0]
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
  return sanitized;
};

const extractJson = (text) => {
  const normalized = normalizeJsonLike(text);
  if (!normalized) return null;
  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
};

const getTextFromRun = (run) => {
  const outputs = run.outputs || {};
  if (outputs.generations) {
    const first = outputs.generations?.[0]?.[0];
    return first?.text || first?.message?.content || "";
  }
  if (outputs.output) return outputs.output;
  if (outputs.content) return outputs.content;
  if (outputs.text) return outputs.text;
  return "";
};

const uniqueCount = (items) => new Set(items.map((item) => String(item))).size;

const main = async () => {
  if (!apiKey) throw new Error("LANGSMITH_API_KEY is not set (env or --api-key)."
  );
  if (!traceId) throw new Error("--trace <TRACE_ID> is required");

  const client = new Client({
    apiKey: apiKey || undefined,
    apiUrl: apiUrl || undefined,
  });

  const runs = await toArray(
    client.listRuns({
      projectName,
      traceId,
      order: "asc",
    }),
    600
  );

  const prepare = runs.find((run) => run.name === "prepare_step");
  const planReview = runs.find((run) => run.name === "plan_review_step");
  if (!prepare) {
    console.log("prepare_step not found.");
    return;
  }

  const planNormalized = prepare.outputs?.plan || null;
  const prepareId = prepare.id;

  const descendants = new Set();
  const byParent = new Map();
  for (const run of runs) {
    const parent = run.parent_run_id || run.parentRunId;
    if (!parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(run);
  }

  const stack = [prepareId];
  while (stack.length) {
    const current = stack.pop();
    const children = byParent.get(current) || [];
    for (const child of children) {
      if (!descendants.has(child.id)) {
        descendants.add(child.id);
        stack.push(child.id);
      }
    }
  }

  const candidateLLMs = runs.filter((run) => {
    const runType = run.run_type || run.runType || "";
    return descendants.has(run.id) && (runType === "llm" || runType === "chat");
  });

  let rawPlan = null;
  for (const run of candidateLLMs) {
    const text = getTextFromRun(run);
    const parsed = extractJson(text);
    if (parsed && parsed.story_title) {
      rawPlan = parsed;
      break;
    }
  }

  console.log(`Trace: ${traceId}`);
  console.log(`prepare_step run: ${prepare.id}`);
  if (planReview) console.log(`plan_review_step run: ${planReview.id}`);

  if (!rawPlan) {
    console.log("Raw plan JSON not found in LLM runs.");
  } else {
    const rawLen = Array.isArray(rawPlan.episode_outlines) ? rawPlan.episode_outlines.length : 0;
    const normLen = Array.isArray(planNormalized?.episode_outlines)
      ? planNormalized.episode_outlines.length
      : 0;
    console.log(`Raw episode_outlines: ${rawLen}`);
    console.log(`Normalized episode_outlines: ${normLen}`);

    const rawSummaries = Array.isArray(rawPlan.episode_outlines)
      ? rawPlan.episode_outlines.map((o) => o?.summary || "")
      : [];
    const normSummaries = Array.isArray(planNormalized?.episode_outlines)
      ? planNormalized.episode_outlines.map((o) => o?.summary || "")
      : [];

    console.log(`Raw unique summaries: ${uniqueCount(rawSummaries)}`);
    console.log(`Normalized unique summaries: ${uniqueCount(normSummaries)}`);

    const rawBeats = Array.isArray(rawPlan.episode_outlines)
      ? rawPlan.episode_outlines.map((o) => Array.isArray(o?.beats) ? o.beats.length : 0)
      : [];
    const normBeats = Array.isArray(planNormalized?.episode_outlines)
      ? planNormalized.episode_outlines.map((o) => Array.isArray(o?.beats) ? o.beats.length : 0)
      : [];

    console.log(`Raw beats counts: ${rawBeats.join(",")}`);
    console.log(`Normalized beats counts: ${normBeats.join(",")}`);
  }

  if (planNormalized) {
    const fields = [
      "story_title",
      "story_summary",
      "format",
      "length_tier",
      "length_type",
      "episode_count",
      "coverage_scope",
    ];
    const summary = {};
    fields.forEach((key) => { summary[key] = planNormalized[key]; });
    console.log(`Normalized plan summary: ${JSON.stringify(summary)}`);
  }

  if (planReview?.inputs?.plan) {
    const inputPlan = planReview.inputs.plan;
    const match = JSON.stringify(inputPlan) === JSON.stringify(planNormalized);
    console.log(`plan_review uses normalized plan: ${match}`);
  }
};

main().catch((error) => {
  console.error(`Trace audit failed: ${error.message}`);
  process.exit(1);
});
