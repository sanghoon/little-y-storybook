#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const CONTENT_DIR = path.resolve(process.cwd(), 'content');
const VERSIONS_DIR = path.join(CONTENT_DIR, 'versions');
const STORIES_PATH = path.join(CONTENT_DIR, 'stories.yml');

const ALLOWED_AGES = new Set(['3-5', '6-7', '8-9']);
const ALLOWED_LENGTH = new Set(['short', 'medium', 'long', 'series']);
const TAG_POOL = new Set([
  '고전각색',
  '전래동화',
  '신화',
  '창작동화',
  '판타지',
  '모험',
  '우정',
  '성장',
  '가족',
  '용기',
  '마법',
  '동물',
  '음악',
  '유머',
  '나눔',
  '희생',
  '정직',
  '자존감',
  '자기이해',
  '협동',
  '재치',
  '지혜',
  '귀향',
  '공주',
  '편견극복',
  '보은',
  '의인화',
]);

const issues = [];

const report = (level, location, message) => {
  issues.push({ level, location, message });
};

const parseFrontmatter = (text, filePath) => {
  if (!text.startsWith('---')) {
    report('error', filePath, 'Missing frontmatter start (---).');
    return { data: null, body: text };
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    report('error', filePath, 'Missing frontmatter end (---).');
    return { data: null, body: text };
  }
  const raw = text.slice(3, end + 1);
  let data = null;
  try {
    data = YAML.parse(raw) || {};
  } catch (error) {
    report('error', filePath, `Frontmatter YAML parse error: ${error.message}`);
  }
  const body = text.slice(end + 4);
  return { data, body };
};

const ensureArray = (value) => Array.isArray(value) ? value : [];

const storyRaw = fs.existsSync(STORIES_PATH) ? fs.readFileSync(STORIES_PATH, 'utf-8') : '';
let stories = [];
try {
  stories = YAML.parse(storyRaw) || [];
} catch (error) {
  report('error', STORIES_PATH, `stories.yml parse error: ${error.message}`);
  stories = [];
}

if (!Array.isArray(stories)) {
  report('error', STORIES_PATH, 'stories.yml must be a YAML array.');
  stories = [];
}

const storyMap = new Map();
const storyVersions = new Map();

stories.forEach((story, index) => {
  const location = `${STORIES_PATH}#${index + 1}`;
  if (!story || typeof story !== 'object') {
    report('error', location, 'Story entry must be an object.');
    return;
  }
  if (!story.id) report('error', location, 'Missing story id.');
  if (!story.title) report('error', location, 'Missing story title.');
  if (!story.summary) report('warning', location, 'Missing story summary.');
  const tags = ensureArray(story.tags);
  if (!tags.length) report('warning', location, 'Story tags empty.');
  tags.forEach((tag) => {
    if (!TAG_POOL.has(tag)) {
      report('warning', location, `Unknown tag: ${tag}`);
    }
  });
  if (story.id) {
    storyMap.set(story.id, story);
    storyVersions.set(story.id, new Set(ensureArray(story.versions).map(String)));
  }
});

const versionFiles = fs.existsSync(VERSIONS_DIR)
  ? fs.readdirSync(VERSIONS_DIR).filter((name) => name.endsWith('.md'))
  : [];

const versionIdMap = new Map();
const versionStoryMap = new Map();

versionFiles.forEach((name) => {
  const filePath = path.join(VERSIONS_DIR, name);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { data, body } = parseFrontmatter(raw, filePath);
  if (!data) return;

  const required = ['id', 'story_id', 'title', 'summary', 'age_range', 'length_type', 'tags'];
  required.forEach((key) => {
    if (!data[key]) report('error', filePath, `Missing frontmatter field: ${key}`);
  });

  const id = String(data.id || '');
  if (id) {
    if (versionIdMap.has(id)) {
      report('error', filePath, `Duplicate version id: ${id}`);
    }
    versionIdMap.set(id, filePath);
  }

  const storyId = String(data.story_id || '');
  if (storyId) {
    versionStoryMap.set(id, storyId);
    if (!storyMap.has(storyId)) {
      report('error', filePath, `story_id not found in stories.yml: ${storyId}`);
    }
  }

  const age = String(data.age_range || '');
  if (age && !ALLOWED_AGES.has(age)) {
    report('error', filePath, `Invalid age_range: ${age}`);
  }

  const lengthType = String(data.length_type || '');
  if (lengthType && !ALLOWED_LENGTH.has(lengthType)) {
    report('error', filePath, `Invalid length_type: ${lengthType}`);
  }

  const match = name.match(/^(.+)__([0-9]-[0-9])__(short|medium|long|series)\.md$/);
  if (!match) {
    report('warning', filePath, 'Filename does not match <slug>__<age>__<length>.md pattern.');
  } else {
    const [, , fileAge, fileLength] = match;
    if (age && fileAge !== age) {
      report('error', filePath, `age_range (${age}) does not match filename (${fileAge}).`);
    }
    if (lengthType && fileLength !== lengthType) {
      report('error', filePath, `length_type (${lengthType}) does not match filename (${fileLength}).`);
    }
  }

  const tags = ensureArray(data.tags);
  if (!tags.length) {
    report('warning', filePath, 'tags empty.');
  } else {
    tags.forEach((tag) => {
      if (!TAG_POOL.has(tag)) {
        report('warning', filePath, `Unknown tag: ${tag}`);
      }
    });
  }

  if (lengthType === 'series') {
    if (!/###\s*1화/.test(body)) {
      report('warning', filePath, 'Series story missing episode headings.');
    }
  }
});

// Cross-check versions listed in stories.yml exist
for (const [storyId, versions] of storyVersions.entries()) {
  for (const versionId of versions) {
    if (!versionIdMap.has(versionId)) {
      report('error', STORIES_PATH, `Version listed but missing file: ${versionId}`);
    }
  }
}

// Check for versions not listed in stories.yml
for (const [versionId, filePath] of versionIdMap.entries()) {
  const storyId = versionStoryMap.get(versionId);
  const versions = storyVersions.get(storyId);
  if (!versions || !versions.has(versionId)) {
    report('warning', filePath, `Version id not listed in stories.yml: ${versionId}`);
  }
}

// Report
const errors = issues.filter((item) => item.level === 'error');
const warnings = issues.filter((item) => item.level === 'warning');

if (issues.length === 0) {
  console.log('OK: no issues found.');
} else {
  const format = (item) => `${item.level.toUpperCase()}: ${item.location} - ${item.message}`;
  issues.forEach((item) => console.log(format(item)));
  console.log(`\\nSummary: ${errors.length} errors, ${warnings.length} warnings.`);  
}

process.exit(errors.length ? 1 : 0);
