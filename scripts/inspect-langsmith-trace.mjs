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

const summarize = (value, max = 600) => {
  if (!value) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
};

const pick = (obj, keys) => {
  const out = {};
  keys.forEach((key) => {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
      out[key] = obj[key];
    }
  });
  return out;
};

const main = async () => {
  if (!apiKey) {
    throw new Error("LANGSMITH_API_KEY is not set (env or --api-key)."
    );
  }
  if (!traceId) {
    throw new Error("--trace <TRACE_ID> is required");
  }

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
    400
  );

  if (!runs.length) {
    console.log("No runs found for trace.");
    return;
  }

  console.log(`Trace: ${traceId}`);
  console.log(`Runs: ${runs.length}`);

  const focus = runs.filter((run) => {
    const name = String(run.name || "").toLowerCase();
    return (
      name.includes("prepare") ||
      name.includes("plan") ||
      name.includes("review") ||
      name.includes("planner") ||
      name.includes("critic")
    );
  });

  const displayRuns = focus.length ? focus : runs;

  for (const run of displayRuns) {
    console.log("\n---");
    console.log(`name: ${run.name || "(unnamed)"}`);
    console.log(`type: ${run.run_type || run.runType || "unknown"}`);
    console.log(`id: ${run.id}`);
    if (run.error) {
      console.log(`error: ${summarize(run.error, 800)}`);
    }
    if (run.inputs) {
      console.log(`inputs: ${summarize(JSON.stringify(run.inputs), 1000)}`);
    }
    if (run.outputs) {
      console.log(`outputs: ${summarize(JSON.stringify(run.outputs), 1000)}`);
    }
    if (run.extra) {
      console.log(`extra: ${summarize(JSON.stringify(pick(run.extra, ["metadata", "invocation_params", "model" ])), 1000)}`);
    }
  }
};

main().catch((error) => {
  console.error(`Trace inspection failed: ${error.message}`);
  process.exit(1);
});
