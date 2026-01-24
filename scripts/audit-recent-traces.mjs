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

const hours = Number(parseArg("--hours", "24"));
const limit = Number(parseArg("--limit", "10"));
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

const analyzeTrace = async (client, traceId) => {
  const runs = await toArray(
    client.listRuns({ projectName, traceId, order: "asc" }),
    600
  );
  const prepare = runs.find((run) => run.name === "prepare_step");
  if (!prepare) return null;

  const planNormalized = prepare.outputs?.plan || null;
  if (!planNormalized) return null;

  const prepareId = prepare.id;
  const byParent = new Map();
  for (const run of runs) {
    const parent = run.parent_run_id || run.parentRunId;
    if (!parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(run);
  }

  const descendants = new Set();
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

  if (!rawPlan) return null;

  const rawOutlines = Array.isArray(rawPlan.episode_outlines) ? rawPlan.episode_outlines : [];
  const normOutlines = Array.isArray(planNormalized.episode_outlines)
    ? planNormalized.episode_outlines
    : [];

  const rawSummaries = rawOutlines.map((o) => o?.summary || "");
  const normSummaries = normOutlines.map((o) => o?.summary || "");
  const rawBeats = rawOutlines.map((o) => Array.isArray(o?.beats) ? o.beats.length : 0);
  const normBeats = normOutlines.map((o) => Array.isArray(o?.beats) ? o.beats.length : 0);

  const issues = [];
  if (rawOutlines.length && rawOutlines.length !== normOutlines.length) {
    issues.push(`episode_outlines length mismatch (raw ${rawOutlines.length} vs normalized ${normOutlines.length})`);
  }
  if (rawSummaries.length && uniqueCount(rawSummaries) > uniqueCount(normSummaries)) {
    issues.push(`unique summary count dropped (raw ${uniqueCount(rawSummaries)} vs normalized ${uniqueCount(normSummaries)})`);
  }
  if (rawBeats.some((n) => n > 0) && normBeats.every((n) => n === 0)) {
    issues.push("beats lost during normalization (raw had beats, normalized all zero)");
  }

  if (!issues.length) return null;
  return { traceId, storyTitle: rawPlan.story_title, issues };
};

const main = async () => {
  if (!apiKey) throw new Error("LANGSMITH_API_KEY is not set (env or --api-key)."
  );

  const client = new Client({
    apiKey: apiKey || undefined,
    apiUrl: apiUrl || undefined,
  });

  const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  const roots = await toArray(
    client.listRuns({
      projectName,
      startTime,
      executionOrder: 1,
      limit,
      order: "desc",
    }),
    limit
  );

  if (!roots.length) {
    console.log("No runs found.");
    return;
  }

  const issues = [];
  for (const root of roots) {
    const traceId = root.trace_id || root.traceId || root.id;
    const result = await analyzeTrace(client, traceId);
    if (result) issues.push(result);
  }

  if (!issues.length) {
    console.log("No normalization issues detected in recent traces.");
    return;
  }

  console.log("Potential normalization issues:");
  for (const item of issues) {
    console.log(`- Trace ${item.traceId} (${item.storyTitle || "unknown"}):`);
    item.issues.forEach((issue) => console.log(`  - ${issue}`));
  }
};

main().catch((error) => {
  console.error(`Audit failed: ${error.message}`);
  process.exit(1);
});
