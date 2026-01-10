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

const summarize = (value, max = 240) => {
  if (!value) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
};

const main = async () => {
  const client = new Client({
    apiKey: apiKey || undefined,
    apiUrl: apiUrl || undefined,
  });
  if (!apiKey) {
    throw new Error("LANGSMITH_API_KEY is not set (env or --api-key).");
  }
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

  console.log(`Project: ${projectName}`);
  console.log(`Window: last ${hours}h | Root runs: ${roots.length}`);

  for (const root of roots) {
    const traceId = root.trace_id || root.traceId || root.id;
    console.log("\n=== Trace ===");
    console.log(`Root: ${root.name || "(unnamed)"}`);
    console.log(`Run ID: ${root.id}`);
    console.log(`Trace ID: ${traceId}`);
    console.log(`Start: ${root.start_time}`);
    if (root.error) {
      console.log(`Root Error: ${summarize(root.error, 400)}`);
    }

    const runs = await toArray(
      client.listRuns({
        projectName,
        traceId,
        order: "asc",
      }),
      200
    );

    const errorRuns = runs.filter((run) => run.error);
    if (!errorRuns.length) {
      console.log("Errors: none");
      continue;
    }

    console.log(`Errors: ${errorRuns.length}`);
    for (const run of errorRuns) {
      console.log("- Run:");
      console.log(`  name: ${run.name || "(unnamed)"}`);
      console.log(`  type: ${run.run_type || run.runType || "unknown"}`);
      console.log(`  id: ${run.id}`);
      console.log(`  error: ${summarize(run.error, 600)}`);
      if (run.outputs) {
        console.log(`  outputs: ${summarize(JSON.stringify(run.outputs), 600)}`);
      }
    }
  }
};

main().catch((error) => {
  console.error(`Trace analysis failed: ${error.message}`);
  process.exit(1);
});
