#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const ROOT_DIR = process.cwd();
const VERSIONS_DIR = path.resolve(ROOT_DIR, 'content', 'versions');
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(\n|$)/;

const toIsoString = (value) => {
  if (!value) return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
};

const resolveUpdatedAt = ({ filePath, frontmatter }) => {
  try {
    const data = YAML.parse(frontmatter) ?? {};
    const metaPath = typeof data.generation_meta_path === 'string'
      ? data.generation_meta_path.trim()
      : '';

    if (metaPath) {
      const resolvedMetaPath = path.resolve(ROOT_DIR, metaPath);
      if (fs.existsSync(resolvedMetaPath)) {
        try {
          const metaRaw = fs.readFileSync(resolvedMetaPath, 'utf-8');
          const meta = JSON.parse(metaRaw);
          const generatedAt = toIsoString(meta.generated_at);
          if (generatedAt) {
            return { updatedAt: generatedAt, source: 'meta' };
          }
        } catch {
          // fall back to mtime
        }
      }
    }
  } catch {
    // fall back to mtime
  }

  const stat = fs.statSync(filePath);
  return { updatedAt: stat.mtime.toISOString(), source: 'mtime' };
};

const upsertUpdatedAt = (frontmatter, updatedAt) => {
  const lines = frontmatter
    .split('\n')
    .filter((line) => !/^\s*updated_at\s*:/.test(line));
  const updatedLine = `updated_at: "${updatedAt}"`;

  const pipelineVersionIndex = lines.findIndex((line) => /^\s*pipeline_version\s*:/.test(line));
  if (pipelineVersionIndex >= 0) {
    lines.splice(pipelineVersionIndex + 1, 0, updatedLine);
    return lines.join('\n');
  }

  const tagsIndex = lines.findIndex((line) => /^\s*tags\s*:/.test(line));
  if (tagsIndex >= 0) {
    lines.splice(tagsIndex, 0, updatedLine);
    return lines.join('\n');
  }

  lines.push(updatedLine);
  return lines.join('\n');
};

const run = () => {
  if (!fs.existsSync(VERSIONS_DIR)) {
    throw new Error(`Versions directory not found: ${VERSIONS_DIR}`);
  }

  const files = fs
    .readdirSync(VERSIONS_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort();

  let changedCount = 0;
  let metaSourceCount = 0;
  let mtimeSourceCount = 0;

  files.forEach((file) => {
    const filePath = path.join(VERSIONS_DIR, file);
    const source = fs.readFileSync(filePath, 'utf-8');
    const match = source.match(FRONTMATTER_RE);

    if (!match) {
      throw new Error(`Frontmatter not found: ${filePath}`);
    }

    const frontmatter = match[1];
    const separator = match[2] || '\n';
    const body = source.slice(match[0].length);
    const { updatedAt, source: updatedAtSource } = resolveUpdatedAt({
      filePath,
      frontmatter,
    });
    const nextFrontmatter = upsertUpdatedAt(frontmatter, updatedAt);
    const nextSource = `---\n${nextFrontmatter}\n---${separator}${body}`;

    if (nextSource !== source) {
      fs.writeFileSync(filePath, nextSource, 'utf-8');
      changedCount += 1;
      if (updatedAtSource === 'meta') {
        metaSourceCount += 1;
      } else {
        mtimeSourceCount += 1;
      }
    }
  });

  console.log(`Backfilled updated_at in ${changedCount} files.`);
  if (changedCount > 0) {
    console.log(`- meta source: ${metaSourceCount}`);
    console.log(`- mtime source: ${mtimeSourceCount}`);
  }
};

run();
