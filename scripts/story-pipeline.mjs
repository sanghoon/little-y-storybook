#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import YAML from 'yaml';
import { ChatOpenAI } from '@langchain/openai';
import { StateGraph, START, END } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

const DEFAULT_MODEL = process.env.STORY_MODEL ?? 'gpt-5.1';
const DEFAULT_REASONING_EFFORT = process.env.REASONING_EFFORT ?? 'medium';
const DEFAULT_PLAN_MAX_ITERATIONS = Number(process.env.PLAN_MAX_ITERATIONS ?? 2);
// Bump this when prompts or pipeline logic change materially.
const PIPELINE_VERSION = 'v2';
const CONTENT_DIR = path.resolve(process.cwd(), 'content', 'versions');
const PIPELINE_DIR = path.resolve(process.cwd(), 'pipeline');
const PIPELINE_META_DIR = path.join(PIPELINE_DIR, 'meta');
const STORIES_PATH = path.resolve(process.cwd(), 'content', 'stories.yml');

const HELP_TEXT = `\
Usage:
  npm run generate:story -- --title "..." --synopsis "..." [options]

Options:
  --title "..."              Story title (required unless synopsis provided)
  --story-title "..."        Canonical story title for version grouping
  --story-id "story_###"     Reuse an existing story id from content/stories.yml
  --synopsis "..."           Story synopsis (required unless title provided)
  --synopsis-file "path"      Load synopsis from file
  --age "3-5|6-7|8-9"          Target age range (optional)
  --length "short|medium|long|series|auto"
  --episodes "N"              Force episode count when length is series
  --source "..."              Source/original story title
  --tags "tag1,tag2"          Comma-separated tags
  --model "gpt-5.1"            Override model (default: ${DEFAULT_MODEL})
  --max-iterations "N"         Critic rewrite loop limit (capped at 2)
  --plan-max-iterations "N"    Plan review loop limit (default: ${DEFAULT_PLAN_MAX_ITERATIONS})
  --slug "custom-slug"         Override filename slug
  --output "path"              Override output file path
  --overwrite                 Overwrite existing file
  --print                     Print final markdown to stdout
  --dry-run                   Skip writing output
  --no-tracing                Disable LangChain tracing even if env is set
  --help                      Show this help

Pipeline:
  pipeline_version: ${PIPELINE_VERSION}
`;

const BOOLEAN_FLAGS = new Set([
  'help',
  'overwrite',
  'print',
  'dry-run',
  'no-tracing',
]);

const parseArgs = (argv) => {
  const args = {
    title: '',
    storyTitle: '',
    storyId: '',
    synopsis: '',
    synopsisFile: '',
    age: '',
    length: 'auto',
    episodes: undefined,
    source: '',
    tags: [],
    model: DEFAULT_MODEL,
    maxIterations: 5,
    planMaxIterations: DEFAULT_PLAN_MAX_ITERATIONS,
    slug: '',
    output: '',
    overwrite: false,
    print: false,
    dryRun: false,
    noTracing: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    i += 1;
    switch (key) {
      case 'title':
        args.title = value;
        break;
      case 'story-title':
        args.storyTitle = value;
        break;
      case 'story-id':
        args.storyId = value;
        break;
      case 'synopsis':
        args.synopsis = value;
        break;
      case 'synopsis-file':
        args.synopsisFile = value;
        break;
      case 'age':
        args.age = value;
        break;
      case 'length':
        args.length = value;
        break;
      case 'episodes':
        args.episodes = Number(value);
        break;
      case 'source':
        args.source = value;
        break;
      case 'tags':
        args.tags = value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        break;
      case 'model':
        args.model = value;
        break;
      case 'max-iterations':
        args.maxIterations = Number(value);
        break;
      case 'plan-max-iterations':
        args.planMaxIterations = Number(value);
        break;
      case 'slug':
        args.slug = value;
        break;
      case 'output':
        args.output = value;
        break;
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }

  return args;
};

const sanitizeLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();


const slugifyAscii = (value) => {
  const base = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return base;
};

const escapeYaml = (value) => `"${String(value).replace(/"/g, '\\"')}"`;

const resolveOutputPath = ({ slug, ageRange, lengthType, output }) => {
  if (output) return path.resolve(process.cwd(), output);
  const safeSlug = slug || `story-${Date.now()}`;
  const ageSlug = String(ageRange ?? '').replace(/\s+/g, '');
  const lengthSlug = lengthType || 'short';
  return path.join(CONTENT_DIR, `${safeSlug}__${ageSlug}__${lengthSlug}.md`);
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const LENGTH_PROFILE = {
  short: { min: 700, max: 1100 },
  medium: { min: 1100, max: 1700 },
  long: { min: 1700, max: 2500 },
  series: { min: 700, max: 1700 },
};

const getLengthTarget = (_ageRange, lengthType) => {
  const target = LENGTH_PROFILE[lengthType] ?? LENGTH_PROFILE.short;
  return { ...target, unit: 'chars_no_space' };
};

const AGE_TIER_PROFILE = {
  toddler: {
    maxCharacters: 2,
    endingStyle: '리듬 있는 했어요체 + 의성어/의태어',
    sentenceLengthRule: '단문 위주 (주어+동사 중심)',
    forbiddenMaterials: '공포, 어둠, 큰 소리, 부모와의 분리',
    conflictResolution: '즉각적 해결, 해피엔딩 필수',
  },
  preschool: {
    maxCharacters: 3,
    endingStyle: '친절한 했어요체 (질문형 어미 허용)',
    sentenceLengthRule: '중문 위주, 접속사 1개 이하',
    forbiddenMaterials: '구체적인 폭력, 죽음, 유괴',
    conflictResolution: '권선징악/화해 중심, 해피엔딩',
  },
  lower_elem: {
    maxCharacters: 4,
    endingStyle: '차분한 했어요체 또는 했습니다체 중 하나 (작품 내 일관)',
    sentenceLengthRule: '복문 허용, 호흡 분절',
    forbiddenMaterials: '심한 신체 훼손, 비극적 결말',
    conflictResolution: '원작의 결말과 톤을 가능한 한 유지 (억지 해피엔딩 금지)',
  },
  upper_elem: {
    maxCharacters: 5,
    endingStyle: '담백한 낭독체',
    sentenceLengthRule: '제한 없음',
    forbiddenMaterials: '선정성, 과도한 잔혹성',
    conflictResolution: '복합적 갈등 허용',
  },
};

const getNumericAge = (ageRange) => {
  switch (ageRange) {
    case '3-5':
      return 4;
    case '6-7':
      return 6.5;
    case '8-9':
      return 8.5;
    default:
      return 7;
  }
};

const getAgeTier = (ageRange) => {
  const age = getNumericAge(ageRange);
  if (age <= 3) return 'toddler';
  if (age <= 6) return 'preschool';
  if (age <= 9) return 'lower_elem';
  return 'upper_elem';
};

const getAgeProfile = (ageRange) => {
  const tier = getAgeTier(ageRange);
  return AGE_TIER_PROFILE[tier] ?? AGE_TIER_PROFILE.lower_elem;
};


const getSafetyGuidance = (ageRange) => {
  const tier = getAgeTier(ageRange);
  if (tier === 'toddler') {
    return '죽음/피/공포/유괴는 금지. 위협은 장난/실수로 낮추고 즉시 해결.';
  }
  if (tier === 'preschool') {
    return '죽음은 은유(먼 여행/별이 됨)로 처리. 구체적 폭력/신체 훼손 묘사는 금지.';
  }
  if (tier === 'lower_elem') {
    return '과도한 잔혹/신체 훼손 금지. 위협은 모험 톤으로 절제.';
  }
  return '선정성/과도한 잔혹성 금지. 비극적 결말은 과장 없이 처리.';
};

const measureLength = (text) => {
  const normalized = String(text ?? '');
  const noSpace = normalized.replace(/\s+/g, '');
  const sentences = normalized.split(/[.!?。？！]+/).filter((s) => s.trim()).length;
  return {
    char_count: normalized.length,
    char_count_no_space: noSpace.length,
    word_count: normalized.trim() ? normalized.trim().split(/\s+/).length : 0,
    sentence_count: sentences,
    line_count: normalized.trim() ? normalized.trim().split('\n').length : 0,
  };
};

const checkLength = (metrics, target) => {
  const value = metrics.char_count_no_space;
  const ok = value >= target.min && value <= target.max;
  const diff = value < target.min ? target.min - value : value > target.max ? value - target.max : 0;
  const range = Math.max(1, target.max - target.min);
  const softThreshold = Math.max(120, Math.round(range * 0.15));
  const hardThreshold = Math.max(250, Math.round(range * 0.35));
  const severity = ok ? 'ok' : diff <= softThreshold ? 'soft' : diff <= hardThreshold ? 'medium' : 'hard';
  return {
    ok,
    value,
    diff,
    severity,
  };
};

const META_SUMMARY_TOKENS = [
  '낭독용',
  '부작',
  '각색',
  '버전',
  '시리즈',
  '에피소드',
  '분량',
];

const hasMetaSummary = (value) => {
  if (!value) return false;
  return META_SUMMARY_TOKENS.some((token) => String(value).includes(token));
};

const findOverRepeatedSentences = (text, minCount = 3) => {
  const sentences = String(text ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const counts = new Map();
  for (const sentence of sentences) {
    if (sentence.length < 6) continue;
    counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= minCount)
    .map(([sentence, count]) => ({ sentence, count }));
};

const countListenerPrompts = (text) => {
  const patterns = [
    '우리도',
    '함께 말해',
    '함께 말해요',
    '같이 말해',
    '같이 말해요',
    '따라 해',
    '따라해',
    '같이 해',
    '같이 해요',
  ];
  const source = String(text ?? '');
  return patterns.reduce((sum, pattern) => sum + source.split(pattern).length - 1, 0);
};

const findListenerPromptSample = (text) => {
  const patterns = [
    '우리도',
    '함께 말해',
    '함께 말해요',
    '같이 말해',
    '같이 말해요',
    '따라 해',
    '따라해',
    '같이 해',
    '같이 해요',
  ];
  const source = String(text ?? '');
  for (const pattern of patterns) {
    if (source.includes(pattern)) return pattern;
  }
  return '';
};

const getStyleSample = (text, maxChars = 260) => {
  const source = String(text ?? '').trim();
  if (!source) return '';
  return source.slice(0, maxChars);
};

const aggregateLengthMetrics = (episodeMeta) => {
  const metrics = (episodeMeta ?? []).map((item) => item.length_metrics).filter(Boolean);
  if (metrics.length === 0) return null;
  return metrics.reduce(
    (acc, item) => ({
      char_count: acc.char_count + (item.char_count ?? 0),
      char_count_no_space: acc.char_count_no_space + (item.char_count_no_space ?? 0),
      word_count: acc.word_count + (item.word_count ?? 0),
      sentence_count: acc.sentence_count + (item.sentence_count ?? 0),
      line_count: acc.line_count + (item.line_count ?? 0),
    }),
    {
      char_count: 0,
      char_count_no_space: 0,
      word_count: 0,
      sentence_count: 0,
      line_count: 0,
    }
  );
};

const loadStories = () => {
  if (!fs.existsSync(STORIES_PATH)) return [];
  const raw = fs.readFileSync(STORIES_PATH, 'utf-8');
  const data = YAML.parse(raw);
  return Array.isArray(data) ? data : [];
};

const saveStories = (stories) => {
  const doc = new YAML.Document();
  doc.contents = stories;
  doc.options.indent = 2;
  doc.options.lineWidth = 0;
  fs.writeFileSync(STORIES_PATH, String(doc), 'utf-8');
};

const nextStoryId = (stories) => {
  const ids = stories
    .map((story) => String(story.id ?? ''))
    .map((id) => id.match(/\d+/)?.[0])
    .filter(Boolean)
    .map(Number);
  const next = ids.length ? Math.max(...ids) + 1 : 1;
  return `story_${String(next).padStart(3, '0')}`;
};

const nextVersionId = (storyId, stories) => {
  const story = stories.find((entry) => entry.id === storyId);
  const existing = new Set((story?.versions ?? []).map(String));
  const base = storyId.match(/\d+/)?.[0] ?? storyId;
  let index = 1;
  let candidate = `ver_${base}_${String(index).padStart(2, '0')}`;
  while (existing.has(candidate)) {
    index += 1;
    candidate = `ver_${base}_${String(index).padStart(2, '0')}`;
  }
  return candidate;
};

const stripFences = (text) => {
  const source = String(text ?? '').trim();
  const fenceMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return source
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
};

const findJsonCandidates = (text) => {
  const source = stripFences(text);
  const candidates = [];
  const stack = [];
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (char === '"' && !escaped) {
        inString = false;
      }
      if (char === '\\' && !escaped) {
        escaped = true;
      } else {
        escaped = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }

    if (char === '{' || char === '[') {
      if (stack.length === 0) start = i;
      stack.push(char === '{' ? '}' : ']');
      continue;
    }

    if (char === '}' || char === ']') {
      if (stack.length && char === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0 && start !== -1) {
          candidates.push(source.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  return candidates;
};

const normalizeJsonLike = (text) => {
  const candidates = findJsonCandidates(text);
  if (!candidates.length) return '';
  const sanitized = candidates[0]
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
  return sanitizeJsonString(sanitized);
};

const sanitizeJsonString = (value) => {
  let inString = false;
  let escaped = false;
  let output = '';
  for (const char of value) {
    if (inString) {
      if (char === '\n') {
        output += '\\n';
        continue;
      }
      if (char === '\r') {
        continue;
      }
      if (char === '\t') {
        output += '\\t';
        continue;
      }
    }
    if (char === '"' && !escaped) {
      inString = !inString;
    }
    if (char === '\\' && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
    output += char;
  }
  return output;
};

const extractJson = (text) => {
  const candidates = findJsonCandidates(text);
  for (const candidate of candidates) {
    const sanitized = sanitizeJsonString(
      candidate.replace(/,\s*([}\]])/g, '$1').trim()
    );
    try {
      return JSON.parse(sanitized);
    } catch {
      // try next candidate
    }
  }
  const normalized = normalizeJsonLike(text);
  if (!normalized) {
    throw new Error('JSON block not found in model output');
  }
  return JSON.parse(normalized);
};

const invokeJson = async (model, messages, label, schema) => {
  const response = await model.invoke(messages);
  const content = String(response.content ?? '');
  try {
    return extractJson(content);
  } catch (error) {
    if (schema && typeof model.withStructuredOutput === 'function') {
      try {
        const structured = model.withStructuredOutput(schema);
        return await structured.invoke(messages);
      } catch {
        // fall through to fixer
      }
    }
    try {
      const repaired = normalizeJsonLike(content);
      if (repaired) return JSON.parse(repaired);
    } catch {
      // fall through to model fixer
    }
    const systemHint = messages.find((msg) => msg instanceof SystemMessage)?.content ?? '';
    const fixer = await model.invoke([
      new SystemMessage(
        'Return only valid JSON. No markdown, no extra text. Fix formatting issues and keep the schema.'
      ),
      new HumanMessage(`SYSTEM PROMPT (SCHEMA):\n${systemHint}\n\nLabel: ${label}\n\n${content}`),
    ]);
    try {
      return extractJson(fixer.content);
    } catch (fixError) {
      const strictFixer = await model.invoke([
        new SystemMessage(
          'Output JSON only. Use double quotes for all keys/strings. No trailing commas.'
        ),
        new HumanMessage(`Label: ${label}\n\n${fixer.content}`),
      ]);
      return extractJson(strictFixer.content);
    }
  }
};

const invokeWithSchema = async (model, messages, label, schema, options = {}) => {
  const useStructured = options.useStructured !== false;
  if (useStructured && schema && typeof model.withStructuredOutput === 'function') {
    try {
      return await model.withStructuredOutput(schema).invoke(messages);
    } catch {
      // fall back to lenient JSON parsing
    }
  }
  const parsed = await invokeJson(model, messages, label, schema);
  return schema ? schema.parse(parsed) : parsed;
};

const invokeTwoStage = async (model, prompt, label, schema, options = {}) => {
  const stage1Messages = [
    new SystemMessage(prompt.system),
    new HumanMessage(prompt.stage1),
  ];
  const stage1 = await model.invoke(stage1Messages);
  const stage2Messages = [
    ...stage1Messages,
    stage1,
    new HumanMessage(prompt.stage2),
  ];
  return invokeWithSchema(model, stage2Messages, label, schema, options);
};

const ensureTracing = (args) => {
  if (args.noTracing) return;
  if (
    process.env.LANGSMITH_TRACING === 'true' ||
    process.env.LANGSMITH_TRACING_V2 === 'true' ||
    process.env.LANGCHAIN_TRACING_V2 === 'true'
  ) {
    if (!process.env.LANGCHAIN_CALLBACKS_BACKGROUND) {
      process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';
    }
    return;
  }
  if (process.env.LANGCHAIN_API_KEY || process.env.LANGSMITH_API_KEY) {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_TRACING_V2 = 'true';
    process.env.LANGCHAIN_TRACING_V2 = 'true';
    if (!process.env.LANGCHAIN_CALLBACKS_BACKGROUND) {
      process.env.LANGCHAIN_CALLBACKS_BACKGROUND = 'false';
    }
  }
};

const buildModels = (args) => {
  const base = {
    model: args.model,
    modelKwargs: {
      reasoning_effort: DEFAULT_REASONING_EFFORT,
    },
  };

  const supportsTemperature = !/^gpt-5/i.test(args.model);
  const planner = supportsTemperature ? { temperature: 0.4 } : {};
  const writer = supportsTemperature ? { temperature: 0.7 } : {};
  const reviewer = supportsTemperature ? { temperature: 0.2 } : {};

  return {
    planner: new ChatOpenAI({ ...base, ...planner }),
    writer: new ChatOpenAI({ ...base, ...writer }),
    reviewer: new ChatOpenAI({ ...base, ...reviewer }),
  };
};

const planPrompt = (input) => {
  const system = `You are a professional story architect for children's read-aloud literature.

[GLOBAL LANGUAGE RULE]
1. MAIN OUTPUT LANGUAGE: KOREAN (한국어).
2. Even if input is in English, output must be fluent Korean.
3. Avoid translationese; use natural Korean suitable for children.

[HOW THIS PLAN WILL BE USED]
- story_title / version_title: canonical title and version grouping.
- story_summary / version_summary: used in listings; must be pure story content.
- characters: writer must only use these names; editor will restore names when pronouns appear.
- plot_outline: writer expands scene-by-scene; critic checks alignment.
- episode_outlines: each episode is generated from its outline; must be distinct.
- tone_guide / style_guide: writer and editor must follow for voice consistency.
- format / length_tier: core format choice used by CLI for layout and length targets.

Rules:
- Assume the title refers to a known story. Use source_basis=\"known_story\" and source_title as the original title.
- If the original content is age-appropriate, retell it faithfully. You may condense or omit, but do NOT twist the ending or add new events/moral frames that are not in the original.
- Avoid explicit moralizing statements in summaries and outlines; keep lessons implicit unless the original is explicitly didactic.
- Preserve any core plot device or binding condition that drives the original story (e.g., a rule, vow, or restraint), using safe wording if needed.
- If the user forces length=series or provides episode_count, set format=\"series\" and keep episode_count within 3~8 (adjust to range if needed).
- If input length=auto, choose format/length_tier based on story scale and target age (large epics for age>=7 may be series; otherwise single).
- If format is series, plan 3~8 episodes with clear cut points; include a gentle cliffhanger.
- format and length_tier must be MECE: format is either single or series; length_tier is short/medium/long for single and \"series\" for series.
- Limit main characters to the provided max_characters; merge or remove minors.
- Provide canonical story_title used for all versions. Keep it stable and short.
- Set version_title to the same as story_title unless the user explicitly requests a different title.
- story_summary/version_summary must describe the story content only (no production notes like ‘낭독용/부작/각색/버전’).
- Provide story_slug_en as lowercase ASCII kebab-case (e.g., alice-in-wonderland). No non-ASCII.
- Do NOT include story_text or any long prose. Planning fields must stay short and single-line.
- Do NOT include line breaks inside any string values.
- Use ONLY the keys shown in the schema example; do not add extra keys.
- Use tags from this pool when applicable: 고전각색, 전래동화, 신화, 창작동화, 판타지, 모험, 우정, 성장, 가족, 용기, 마법, 동물, 음악, 유머, 나눔, 희생, 정직, 자존감, 자기이해, 협동, 재치, 지혜, 귀향, 공주, 편견극복, 보은, 의인화.
- plot_outline should be scene-by-scene (brief lines).
- Define a clear, consistent tone_guide and style_guide (narrator voice, tense, rhythm, dialogue style).
- Respect provided age range, length, or episode count unless it harms suitability.

[Field Definitions]
- source_basis: known_story | user_synopsis | original
- format: single | series
- length_tier: short | medium | long | series
`;

  const ageProfile = getAgeProfile(input.age);
  const payload = {
    title: input.title,
    story_title: input.storyTitle,
    story_id: input.storyId,
    synopsis: input.synopsis,
    age_range: input.age,
    length_type: input.length,
    source_title: input.source || input.title || '',
    source_basis: input.synopsis ? 'user_synopsis' : 'known_story',
    tags: input.tags,
    requested_episodes: input.episodes,
    max_characters: ageProfile.maxCharacters,
    ending_style: ageProfile.endingStyle,
    sentence_length_rule: ageProfile.sentenceLengthRule,
    forbidden_materials: ageProfile.forbiddenMaterials,
    conflict_resolution: ageProfile.conflictResolution,
  };

  const stage1 = `TASK (Stage 1): Provide a concise natural-language plan using the rules above.
Do NOT output JSON. Focus on key decisions (format, episode count, coverage scope, main characters, plot outline, tone/style).

STORY REQUEST:
\"\"\"
${JSON.stringify(payload, null, 2)}
\"\"\"`;

  const stage2 = `TASK (Stage 2): Using your previous answer and the story request, fill the JSON schema below.
Fill any missing fields yourself. Output ONLY valid JSON (no markdown, no commentary).
Use empty strings/arrays instead of null. enum 값은 반드시 아래 예시의 철자와 소문자를 그대로 사용.

Output schema example:
{
  \"source_title\": \"...\",
  \"source_basis\": \"known_story\",
  \"story_title\": \"...\",
  \"version_title\": \"...\",
  \"story_slug_en\": \"alice-in-wonderland\",
  \"target_age_range\": \"6-7\",
  \"format\": \"single\",
  \"length_tier\": \"short\",
  \"episode_count\": 1,
  \"coverage_scope\": \"...\",
  \"story_summary\": \"...\",
  \"version_summary\": \"...\",
  \"tags\": [\"...\"],
  \"characters\": [\"...\"],
  \"setting\": \"...\",
  \"themes\": [\"...\"],
  \"plot_outline\": [\"...\"],
  \"episode_outlines\": [{\"episode\": 1, \"title\": \"...\", \"summary\": \"...\", \"beats\": [\"...\"]}],
  \"tone_guide\": \"...\",
  \"style_guide\": \"...\"
}`;

  return { system, stage1, stage2 };
};

const planReviewPrompt = ({ plan, input, lengthTarget }) => {
  const ageProfile = getAgeProfile(plan?.target_age_range);
  const lengthTargetScope = plan?.length_type === 'series' ? 'per_episode' : 'single_story';
  const system = `You are a veteran Korean children's book editor and read-aloud specialist.

[Purpose]
- Judge whether this plan can be executed by the Writer and Editor without confusion.
- Your output will be used to revise the plan. If you mark \"revise\", the Planner will rewrite the plan using your revision_brief.
- In this step, do NOT evaluate read-aloud rhythm or oral performance; focus on structure and content only.
- status must be \"pass\" or \"revise\".

[How the plan will be used]
- plot_outline + episode_outlines are expanded into scenes.
- characters list is the ONLY allowed main characters.
- tone_guide/style_guide control voice and oral conversion.
- length_target_scope tells you whether length_target is per-episode or for a single story.

[Review Checklist]
1. Format: format is single or series (MECE).
2. Length Tier: if format=single then length_tier is short/medium/long; if format=series then length_tier is "series".
3. Episode Count: single -> 1, series -> 3~8.
4. Character Load: characters <= max_characters.
4b. Character Consistency: any named character in outlines must appear in characters (use generic roles otherwise).
5. Outline Quality: plot_outline is scene-by-scene; episode_outlines are distinct and cover different events.
6. Age Fit: tone/style and safety are appropriate for the age.
7. Fidelity: if the original is age-appropriate, preserve the original ending and events; do NOT add new events or moral framing.
8. Summaries: story_summary/version_summary must be pure story content (no production notes).
9. If the user forced series length, do NOT downgrade; focus on keeping the series plan coherent.
`;

  const stage1 = `TASK (Stage 1): Review the plan in natural language.
List issues, must-fix items, and suggestions clearly. Do NOT output JSON.
If you find issues, set status=revise and provide a revision_brief.
Flag any unnecessary deviations (new events, ending twists, or added moral framing) when the original is age-appropriate.
Do NOT request a synopsis when the title is a known classic; keep scope small instead.

PLAN REVIEW INPUT:
\"\"\"
${JSON.stringify(
    {
      story_title: plan.story_title,
      story_summary: plan.story_summary,
      version_title: plan.version_title,
      version_summary: plan.version_summary,
      source_title: plan.source_title,
      source_basis: plan.source_basis,
      target_age_range: plan.target_age_range,
      max_characters: ageProfile.maxCharacters,
      format: plan.format,
      length_tier: plan.length_tier,
      episode_count: plan.episode_count,
      coverage_scope: plan.coverage_scope,
      characters: plan.characters,
      setting: plan.setting,
      themes: plan.themes,
      plot_outline: plan.plot_outline,
      episode_outlines: plan.episode_outlines,
      tone_guide: plan.tone_guide,
      style_guide: plan.style_guide,
      length_target: lengthTarget,
      length_target_scope: lengthTargetScope,
      input_constraints: {
        title: input.title,
        synopsis: input.synopsis,
        source: input.source,
        length: input.length,
        episodes: input.episodes,
        length_forced: input.length && input.length !== 'auto',
        episodes_forced: Boolean(input.episodes),
      },
    },
    null,
    2
  )}
\"\"\"`;

  const stage2 = `TASK (Stage 2): Using your previous answer, fill the JSON schema below.
Fill any missing fields yourself. Output ONLY valid JSON (no markdown, no commentary).
Use [] for empty lists. Do not use null. status는 반드시 "pass" 또는 "revise" (소문자).

Output schema example:
{
  \"status\": \"pass\",
  \"issues\": [{\"type\": \"structure\", \"detail\": \"...\"}],
  \"must_fix\": [],
  \"suggestions\": [],
  \"plan_alignment\": {
    \"read_aloud_ok\": true,
    \"age_fit_ok\": true,
    \"episode_cuts_ok\": true,
    \"notes\": \"\"
  },
  \"revision_brief\": \"\"
}`;

  return { system, stage1, stage2 };
};

const planRevisePrompt = ({ plan, review, input }) => {
  const system = `You are a senior Korean children's literature planner and editor specializing in read-aloud storybooks.

[Purpose]
- Fix the plan based on reviewer feedback.
- This revised plan will be used directly by the Writer and Editor.

[What to do]
1. Resolve every must_fix item.
2. Keep story_title and story_slug_en stable unless explicitly requested.
3. Ensure characters count respects max_characters.
4. Ensure plot_outline is scene-by-scene and episode_outlines are distinct.
5. Ensure tone_guide/style_guide are clear and usable for oral conversion.
6. If the source is unclear, keep scope small but still produce a complete plan.
7. If the original is age-appropriate, preserve its ending/events; remove added moral framing or invented scenes.
8. If the user forced series length or episode count, keep format=\"series\".
9. Do NOT write story text.
`;

  const stage1 = `TASK (Stage 1): Explain how you will revise the plan.
Summarize key fixes and decisions in natural language. Do NOT output JSON.

CURRENT PLAN:
\"\"\"
${JSON.stringify(plan, null, 2)}
\"\"\"

EDITOR REVIEW:
\"\"\"
${JSON.stringify(review, null, 2)}
\"\"\"

INPUT CONSTRAINTS:
\"\"\"
${JSON.stringify(input, null, 2)}
\"\"\"`;
  const stage2 = `TASK (Stage 2): Using your previous answer, output the full revised plan as JSON.
Fill any missing fields yourself. Output ONLY valid JSON (no markdown, no commentary).
Use empty strings/arrays instead of null. enum 값은 반드시 아래 예시의 철자와 소문자를 그대로 사용.

Output schema example:
{
  \"source_title\": \"...\",
  \"source_basis\": \"known_story\",
  \"story_title\": \"...\",
  \"version_title\": \"...\",
  \"story_slug_en\": \"alice-in-wonderland\",
  \"target_age_range\": \"6-7\",
  \"format\": \"single\",
  \"length_tier\": \"short\",
  \"episode_count\": 1,
  \"coverage_scope\": \"...\",
  \"story_summary\": \"...\",
  \"version_summary\": \"...\",
  \"tags\": [\"...\"],
  \"characters\": [\"...\"],
  \"setting\": \"...\",
  \"themes\": [\"...\"],
  \"plot_outline\": [\"...\"],
  \"episode_outlines\": [{\"episode\": 1, \"title\": \"...\", \"summary\": \"...\", \"beats\": [\"...\"]}],
  \"tone_guide\": \"...\",
  \"style_guide\": \"...\"
}`;

  return { system, stage1, stage2 };
};

const draftPrompt = ({ plan, episodeIndex, episodeCount, isFinal, lengthTarget }) => {
  const ageProfile = getAgeProfile(plan?.target_age_range);
  const system = `You are a creative fairy tale writer.

[GLOBAL LANGUAGE RULE]
1. MAIN OUTPUT LANGUAGE: KOREAN (한국어).
2. Even if input is in English, output must be fluent Korean.
3. Avoid translationese; use natural Korean suitable for children.

[Safety Guidelines for Age ${plan?.target_age_range}]
- Violence: ${getSafetyGuidance(plan?.target_age_range)}
- Forbidden: ${ageProfile.forbiddenMaterials}
- Conflict Resolution: ${ageProfile.conflictResolution}

[Instructions]
1. Follow the blueprint strictly (characters, scenes, setting, events).
2. Do NOT add new events or moral lessons beyond the blueprint; do not twist the ending.
3. Write in plain text draft. Use 문어체 중심의 자연스러운 서술.
4. The prose must read like a top-tier Korean children's storybook writer wrote it for this exact age.
4. Do NOT add audio tags, sound effects, or dialogue emotion tags.
5. Do NOT include titles, headings, or metadata.
6. Add sensory details (what characters see, hear, feel).
7. Follow tone_guide/style_guide strictly to keep voice consistent.
8. Keep length within the target range when possible.
9. Avoid didactic lists; show lessons through action and dialogue.
10. For series, continue smoothly from previous episode summary; keep character names consistent.

Output: Draft story text only.`;

  const outline = plan.episode_outlines?.[episodeIndex - 1] ?? {};
  const previousEpisodeSummary = episodeIndex > 1
    ? String(plan.episode_outlines?.[episodeIndex - 2]?.summary || '')
    : '';
  const human = `TASK: Write a draft story in 문어체 based on the blueprint. Do not add audio tags.

BLUEPRINT:
\"\"\"
${JSON.stringify(
    {
      story_title: plan.story_title || plan.title,
      story_summary: plan.story_summary || plan.summary,
      source_title: plan.source_title,
      format: plan.format,
      length_tier: plan.length_tier,
      coverage_scope: plan.coverage_scope,
      target_age_range: plan.target_age_range,
      length_type: plan.length_type,
      tone_guide: plan.tone_guide,
      style_guide: plan.style_guide,
      max_characters: ageProfile.maxCharacters,
      characters: plan.characters,
      setting: plan.setting,
      themes: plan.themes,
      plot_outline: plan.plot_outline,
      episode_count: episodeCount,
      episode_index: episodeIndex,
      episode_outline: outline,
      previous_episode_summary: previousEpisodeSummary,
      length_target: lengthTarget,
      is_final_episode: isFinal,
    },
    null,
    2
  )}
\"\"\"`;

  return [new SystemMessage(system), new HumanMessage(human)];
};

const criticPrompt = ({ plan, draft, episodeIndex, episodeCount, lengthTarget }) => {
  const ageProfile = getAgeProfile(plan?.target_age_range);
  const requiresHappyEnding = plan?.target_age_range === '3-5';
  const system = `Role: Safety & Logic Critic

[GLOBAL LANGUAGE RULE]
1. MAIN OUTPUT LANGUAGE: KOREAN (한국어).
2. Use clear Korean reasoning in Stage 1.

Checklist:
1. Is the content safe for a ${plan?.target_age_range}-year-old?
2. Does the draft follow the blueprint (characters, setting, events)?
3. If age is 3-5, is the ending happy/resolved?
status must be "pass" or "fail".

`;

  const stage1 = `TASK (Stage 1): Evaluate the draft for safety and plan alignment in natural language.
If FAIL, list concise reasons so the Writer can fix them. Do NOT output JSON.

CRITIC INPUT:
\"\"\"
${JSON.stringify(
    {
      story_title: plan.story_title || plan.title,
      target_age_range: plan.target_age_range,
      source_title: plan.source_title,
      format: plan.format,
      length_tier: plan.length_tier,
      coverage_scope: plan.coverage_scope,
      max_characters: ageProfile.maxCharacters,
      characters: plan.characters,
      setting: plan.setting,
      plot_outline: plan.plot_outline,
      episode_outline: plan.episode_outlines?.[episodeIndex - 1] ?? {},
      episode_index: episodeIndex,
      episode_count: episodeCount,
      length_target: lengthTarget,
      safety_guidance: getSafetyGuidance(plan?.target_age_range),
      forbidden_materials: ageProfile.forbiddenMaterials,
      requires_happy_ending: requiresHappyEnding,
    },
    null,
    2
  )}
\"\"\"

DRAFT:
\"\"\"
${draft}
\"\"\"`;
  const stage2 = `TASK (Stage 2): Using your previous answer, output JSON only.
Fill any missing fields yourself. Output ONLY valid JSON (no markdown, no commentary).
Use [] for empty lists. Do not use null. status는 반드시 "pass" 또는 "fail" (소문자).

Output format example:
{
  \"status\": \"pass\",
  \"reasons\": [],
  \"notes\": \"\"
}`;

  return { system, stage1, stage2 };
};

const rewritePrompt = ({ plan, draft, critic, lengthTarget }) => {
  const ageProfile = getAgeProfile(plan?.target_age_range);
  const system = `You are a creative fairy tale writer.

[GLOBAL LANGUAGE RULE]
1. MAIN OUTPUT LANGUAGE: KOREAN (한국어).
2. Output must be fluent Korean.

[Instructions]
- Apply the critic feedback precisely.
- Keep characters, setting, and events aligned to the blueprint.
- Keep 문어체 중심의 서술 (oral conversion will happen later).
- The prose must read like a top-tier Korean children's storybook writer wrote it for this exact age.
- Do NOT add audio tags or emotion cues.
- Maintain age-appropriate safety rules.
- Follow tone_guide/style_guide to keep voice consistent.
- Keep length within target when possible.

Output: Revised draft text only.`;

  const human = `TASK: Rewrite the draft to fix critic issues while preserving the blueprint.
Return ONLY the revised draft text.

BLUEPRINT:
\"\"\"
${JSON.stringify(
    {
      story_title: plan.story_title || plan.title,
      story_summary: plan.story_summary || plan.summary,
      target_age_range: plan.target_age_range,
      length_type: plan.length_type,
      format: plan.format,
      length_tier: plan.length_tier,
      coverage_scope: plan.coverage_scope,
      tone_guide: plan.tone_guide,
      style_guide: plan.style_guide,
      max_characters: ageProfile.maxCharacters,
      characters: plan.characters,
      setting: plan.setting,
      plot_outline: plan.plot_outline,
      length_target: lengthTarget,
      safety_guidance: getSafetyGuidance(plan?.target_age_range),
    },
    null,
    2
  )}
\"\"\"

CRITIC FEEDBACK:
\"\"\"
${JSON.stringify(critic, null, 2)}
\"\"\"

DRAFT:
\"\"\"
${draft}
\"\"\"`;

  return [new SystemMessage(system), new HumanMessage(human)];
};

const editorPrompt = ({ plan, draft, episodeIndex, episodeCount, styleReference }) => {
  const ageProfile = getAgeProfile(plan?.target_age_range);
  const system = `You are a professional script editor for audio storytelling.

[GLOBAL LANGUAGE RULE]
1. MAIN OUTPUT LANGUAGE: KOREAN (한국어).
2. Even if input is in English, output must be fluent Korean.
3. Avoid translationese; use natural Korean suitable for children.

[Style Guide for Age ${plan?.target_age_range}]
- Ending Style: ${ageProfile.endingStyle}
- Sentence Length: ${ageProfile.sentenceLengthRule}
- Clarity: Replace ambiguous pronouns (그/그녀/그것) with proper nouns when possible.
- Consistency: 서술문은 했어요체 또는 했습니다체 중 하나를 선택해 작품 내내 일관되게 유지.
- Dialogue: 등장인물 대사는 인물 성격에 맞게 자유롭게 말투를 구성하되, 과도한 비속어/무례함은 피할 것.

[Audio Direction Rules]
1. Add emotion tags before dialogue: (속삭이며), (활기차게), (울먹이며).
2. Add sound effect tags where necessary: [SFX: 바람 소리].
3. Add pause markers for dramatic timing: [Pause: Short], [Pause: Long].
4. Use tags sparingly—only when they improve oral clarity. Avoid tagging every line.

[Few-Shot Instruction]
- The example below is ONLY for learning the Tone & Manner.
- DO NOT copy any plot, characters, or objects from the example.

Example (style only):
Input: "주방에서 수프가 끓고 있었다. 아이는 냄새를 맡았다."
Output: "[SFX: 보글보글] (활기차게) \"냄새가 좋다!\" 아이가 코를 킁킁했다. [Pause: Short]"

[Refinement Rules]
1. Convert 문어체 endings to 구어체 suitable for the age.
2. Add gentle rhythm and onomatopoeia if the target age is under 6.
3. Break long sentences for breath control.
4. Do NOT change the plot or add new events.
5. The final script must sound like a polished Korean children's storybook written for this exact age.

Output: Polished narration script only.`;

  const human = `TASK: Convert the draft into a read-aloud script with oral-style endings and light audio direction.
Do NOT change the story events.

DRAFT STORY:
\"\"\"
${draft}
\"\"\"

CONTEXT:
\"\"\"
${JSON.stringify(
    {
      story_title: plan.story_title || plan.title,
      target_age_range: plan.target_age_range,
      tone_guide: plan.tone_guide,
      style_guide: plan.style_guide,
      characters: plan.characters,
      episode_index: episodeIndex,
      episode_count: episodeCount,
      style_reference: styleReference,
    },
    null,
    2
  )}
\"\"\"`;

  return [new SystemMessage(system), new HumanMessage(human)];
};

const readTimePrompt = ({ plan, drafts, lengthStats }) => {
  const system = `You are a Korean children's read-aloud editor.\n\nRules:\n- Take time to think carefully before answering.\n- Purpose: estimate read-aloud time for a completed children's storybook.\n- Consider natural read-aloud pacing with expressive pauses.\n- This is not a picture book; the text must stand on its own.\n- Provide minutes as integers (round to nearest whole minute).\n- Output ONLY valid JSON (no markdown, no commentary).\n\nOutput schema example:\n{\n  "total_minutes": 6,\n  "per_episode_minutes": [3, 3]\n}`;

  const payload = {
    story_title: plan.story_title || plan.title,
    target_age_range: plan.target_age_range,
    length_type: plan.length_type,
    length_stats: lengthStats,
    episodes: drafts.map((draft, index) => ({
      episode: index + 1,
      text: draft,
    })),
  };

  const human = `READ-TIME ESTIMATION INPUT:\n"""\n${JSON.stringify(payload, null, 2)}\n"""`;
  return [new SystemMessage(system), new HumanMessage(human)];
};

const estimateReadTimeFallback = (lengthStats, episodeCount) => {
  const totalChars = Number(lengthStats?.char_count_no_space || 0);
  const charsPerMinute = 220;
  const totalMinutes = Math.max(1, Math.round(totalChars / charsPerMinute));
  if (episodeCount > 1) {
    const perEpisode = Array.from({ length: episodeCount }, () =>
      Math.max(1, Math.round(totalMinutes / episodeCount))
    );
    return { total_minutes: totalMinutes, per_episode_minutes: perEpisode };
  }
  return { total_minutes: totalMinutes, per_episode_minutes: [totalMinutes] };
};

const normalizeReadTime = (value, episodeCount, fallback) => {
  const total = Number(
    value?.total_minutes ??
    value?.total_read_time ??
    value?.estimated_read_time ??
    fallback.total_minutes
  );
  let perEpisode = Array.isArray(value?.per_episode_minutes)
    ? value.per_episode_minutes.map((item) => Math.max(1, Number(item)))
    : [];
  if (!perEpisode.length && episodeCount > 1) {
    perEpisode = Array.from({ length: episodeCount }, () =>
      Math.max(1, Math.round(total / episodeCount))
    );
  }
  if (!perEpisode.length) perEpisode = [Math.max(1, total)];
  return {
    total_minutes: Math.max(1, total || fallback.total_minutes || 1),
    per_episode_minutes: perEpisode.slice(0, Math.max(1, episodeCount || 1)),
  };
};

const estimateReadTime = async ({ model, plan, drafts, lengthStats }) => {
  const episodeCount = drafts.length || 1;
  const fallback = estimateReadTimeFallback(lengthStats, episodeCount);
  try {
    const response = typeof model.withStructuredOutput === 'function'
      ? await model.withStructuredOutput(ReadTimeSchema).invoke(readTimePrompt({ plan, drafts, lengthStats }))
      : await invokeJson(
          model,
          readTimePrompt({ plan, drafts, lengthStats }),
          'read_time',
          ReadTimeSchema
        );
    return normalizeReadTime(response, episodeCount, fallback);
  } catch (error) {
    return fallback;
  }
};

const normalizePlan = (plan, input) => {
  const normalized = { ...plan };
  const inputLength = input.length || 'auto';
  const forcedEpisodes = Number.isFinite(input.episodes) ? Number(input.episodes) : undefined;

  normalized.source_title = sanitizeLine(
    normalized.source_title || input.source || input.title || ''
  );
  const basis = String(normalized.source_basis || '').toLowerCase();
  if (['known_story', 'user_synopsis', 'original'].includes(basis)) {
    normalized.source_basis = basis;
  } else {
    normalized.source_basis = input.synopsis ? 'user_synopsis' : 'known_story';
  }
  normalized.story_title = sanitizeLine(
    normalized.story_title || input.storyTitle || input.title || normalized.source_title || 'Untitled'
  );
  normalized.story_summary = sanitizeLine(
    normalized.story_summary || normalized.summary || input.synopsis || ''
  );
  normalized.tone_guide = sanitizeLine(
    normalized.tone_guide || normalized.style_guide || ''
  );
  normalized.version_title = sanitizeLine(
    normalized.version_title || normalized.story_title || ''
  );
  if (input.storyTitle || input.storyId) {
    normalized.version_title = normalized.story_title;
  }
  normalized.version_summary = sanitizeLine(
    normalized.version_summary || normalized.story_summary || ''
  );
  normalized.story_slug_en = sanitizeLine(normalized.story_slug_en || '');
  if (!normalized.story_slug_en || /[^\x00-\x7F]/.test(normalized.story_slug_en)) {
    normalized.story_slug_en = slugifyAscii(normalized.story_title);
  }
  normalized.title = normalized.story_title;
  normalized.target_age_range = input.age || normalized.target_age_range || '6-7';
  if (!normalized.style_guide) {
    normalized.style_guide = normalized.tone_guide || '';
  }
  normalized.coverage_scope = sanitizeLine(normalized.coverage_scope || '');

  if (!Array.isArray(normalized.plot_outline) || normalized.plot_outline.length === 0) {
    normalized.plot_outline = [];
  }
  if (!normalized.coverage_scope && normalized.plot_outline.length) {
    const first = String(normalized.plot_outline[0] || '').trim();
    const last = String(normalized.plot_outline[normalized.plot_outline.length - 1] || '').trim();
    if (first && last) {
      normalized.coverage_scope = first === last ? first : `${first} ~ ${last}`;
    }
  }

  if (inputLength === 'series' || forcedEpisodes) {
    normalized.format = 'series';
    normalized.length_tier = 'series';
    normalized.episode_count = forcedEpisodes ?? normalized.episode_count;
  } else if (['short', 'medium', 'long'].includes(inputLength)) {
    normalized.format = 'single';
    normalized.length_tier = inputLength;
    normalized.episode_count = 1;
  } else {
    const format = String(normalized.format || '').toLowerCase();
    normalized.format = format === 'series' ? 'series' : 'single';
    if (normalized.format === 'series') {
      normalized.length_tier = 'series';
    } else {
      const tier = String(normalized.length_tier || '').toLowerCase();
      normalized.length_tier = ['short', 'medium', 'long'].includes(tier) ? tier : 'short';
    }
  }

  if (normalized.format === 'series') {
    const episodeCount = Number(normalized.episode_count || 3);
    normalized.episode_count = clamp(episodeCount, 3, 8);
  } else {
    normalized.episode_count = 1;
  }

  normalized.length_type = normalized.format === 'series'
    ? 'series'
    : normalized.length_tier || 'short';

  const episodeOutlines = Array.isArray(normalized.episode_outlines)
    ? normalized.episode_outlines
    : [];

  const normalizeOutline = (outline, index) => ({
    episode: Number(outline?.episode) || index + 1,
    title: String(outline?.title || `${normalized.story_title} ${index + 1}화`),
    summary: String(outline?.summary || normalized.story_summary || ''),
    beats: Array.isArray(outline?.beats) ? outline.beats : [],
  });

  if (normalized.format !== 'series') {
    const singleOutline = episodeOutlines[0] ?? {};
    normalized.episode_outlines = [normalizeOutline(singleOutline, 0)];
    normalized.episode_count = 1;
  } else if (episodeOutlines.length) {
    const normalizedOutlines = episodeOutlines.map((outline, index) =>
      normalizeOutline(outline, index)
    );
    if (normalizedOutlines.length < normalized.episode_count) {
      const padding = Array.from(
        { length: normalized.episode_count - normalizedOutlines.length },
        (_, index) => normalizeOutline({}, normalizedOutlines.length + index)
      );
      normalized.episode_outlines = [...normalizedOutlines, ...padding];
    } else {
      normalized.episode_outlines = normalizedOutlines.slice(0, normalized.episode_count);
    }
  } else {
    normalized.episode_outlines = Array.from({ length: normalized.episode_count }, (_, index) =>
      normalizeOutline({}, index)
    );
  }

  if (!Array.isArray(normalized.tags)) {
    normalized.tags = [];
  }
  if (input.tags.length) {
    normalized.tags = Array.from(new Set([...normalized.tags, ...input.tags]));
  }

  const ageProfile = getAgeProfile(normalized.target_age_range);
  if (Array.isArray(normalized.characters) && normalized.characters.length > ageProfile.maxCharacters) {
    normalized.characters = normalized.characters.slice(0, ageProfile.maxCharacters);
  }

  return normalized;
};

const StoryState = z.object({
  input: z.any(),
  plan: z.any().optional(),
  planReview: z.any().optional(),
  planReviewHistory: z.array(z.any()).optional(),
  planIteration: z.number().optional(),
  episodeIndex: z.number().optional(),
  episodeCount: z.number().optional(),
  drafts: z.array(z.string()).optional(),
  draft: z.string().optional(),
  critic: z.any().optional(),
  criticIteration: z.number().optional(),
  editedDraft: z.string().optional(),
  currentMeta: z.any().optional(),
  episodeMeta: z.array(z.any()).optional(),
});

const SourceBasisEnum = z.enum(['known_story', 'user_synopsis', 'original']);
const FormatEnum = z.enum(['single', 'series']);
const LengthTierEnum = z.enum(['short', 'medium', 'long', 'series']);
const AgeRangeEnum = z.enum(['3-5', '6-7', '8-9']);
const IssueTypeEnum = z.enum([
  'structure',
  'format',
  'length',
  'characters',
  'fidelity',
  'summary',
  'clarity',
  'moral',
  'style',
  'safety',
  'consistency',
]);

const IssueTypeSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return 'clarity';
  const normalized = value.toLowerCase().trim();
  return IssueTypeEnum.options.includes(normalized) ? normalized : 'clarity';
}, IssueTypeEnum);

const PlanSchema = z.object({
  source_title: z.string(),
  source_basis: SourceBasisEnum,
  story_title: z.string(),
  version_title: z.string(),
  story_slug_en: z.string(),
  target_age_range: AgeRangeEnum,
  format: FormatEnum,
  length_tier: LengthTierEnum,
  episode_count: z.number(),
  coverage_scope: z.string(),
  story_summary: z.string(),
  version_summary: z.string(),
  tags: z.array(z.string()),
  characters: z.array(z.string()),
  setting: z.string(),
  themes: z.array(z.string()),
  plot_outline: z.array(z.string()),
  episode_outlines: z.array(
    z.object({
      episode: z.number(),
      title: z.string(),
      summary: z.string(),
      beats: z.array(z.string()),
    })
  ),
  tone_guide: z.string().nullable(),
  style_guide: z.string(),
}).strict();

const PlanReviewSchema = z.object({
  status: z.enum(['pass', 'revise']),
  issues: z.array(z.object({ type: IssueTypeSchema, detail: z.string() })).optional(),
  must_fix: z.array(
    z.union([
      z.string(),
      z.object({ detail: z.string() }).passthrough(),
    ])
  ).optional(),
  suggestions: z.array(
    z.union([
      z.string(),
      z.object({ detail: z.string() }).passthrough(),
    ])
  ).optional(),
  plan_alignment: z
    .object({
      read_aloud_ok: z.boolean(),
      age_fit_ok: z.boolean(),
      episode_cuts_ok: z.boolean(),
      notes: z.string(),
    })
    .optional(),
  revision_brief: z.string().optional(),
}).strict();

const CriticSchema = z.object({
  status: z.enum(['pass', 'fail']),
  reasons: z.array(z.string()).optional(),
  notes: z.string().optional(),
}).strict();

const ReadTimeSchema = z.object({
  total_minutes: z.number(),
  per_episode_minutes: z.array(z.number()),
});

const buildGraph = ({ planner, writer, reviewer }) => {
  const graph = new StateGraph(StoryState);

  graph.addNode('prepare_step', async (state) => {
    const plan = await invokeTwoStage(
      planner,
      planPrompt(state.input),
      'plan',
      PlanSchema
    );
    const normalized = normalizePlan(plan, state.input);
    return {
      plan: normalized,
      planReview: undefined,
      planReviewHistory: [],
      planIteration: 0,
      episodeIndex: 1,
      episodeCount: normalized.episode_count,
      drafts: [],
      criticIteration: 0,
      episodeMeta: [],
    };
  });

  graph.addNode('plan_review_step', async (state) => {
    const lengthTarget = getLengthTarget(
      state.plan?.target_age_range,
      state.plan?.length_type
    );
    const review = await invokeTwoStage(
      reviewer,
      planReviewPrompt({ plan: state.plan, input: state.input, lengthTarget }),
      'plan_review',
      PlanReviewSchema,
      { useStructured: false }
    );

    const normalizedReview = {
      ...review,
      status: String(review?.status || 'revise').toLowerCase(),
    };
    if (Array.isArray(normalizedReview.must_fix)) {
      normalizedReview.must_fix = normalizedReview.must_fix
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object') {
            if (typeof item.detail === 'string') return item.detail;
            return JSON.stringify(item);
          }
          return '';
        })
        .filter((item) => String(item).trim().length > 0);
    }
    if (Array.isArray(normalizedReview.suggestions)) {
      normalizedReview.suggestions = normalizedReview.suggestions
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object') {
            if (typeof item.detail === 'string') return item.detail;
            return JSON.stringify(item);
          }
          return '';
        })
        .filter((item) => String(item).trim().length > 0);
    }
    if (Array.isArray(normalizedReview.must_fix) && normalizedReview.must_fix.length > 0) {
      normalizedReview.status = 'revise';
    }

    if (
      hasMetaSummary(state.plan?.story_summary) ||
      hasMetaSummary(state.plan?.version_summary)
    ) {
      normalizedReview.status = 'revise';
      const detail = '요약에 제작 메모(낭독용/부작/각색/버전/시리즈/에피소드/분량)가 포함됨.';
      normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
        ? [...normalizedReview.must_fix, detail]
        : [detail];
      normalizedReview.issues = Array.isArray(normalizedReview.issues)
        ? normalizedReview.issues
        : [];
      normalizedReview.issues.push({ type: 'summary', detail });
    }

    const episodeSummaries = Array.isArray(state.plan?.episode_outlines)
      ? state.plan.episode_outlines
          .map((outline) => String(outline?.summary || '').trim())
          .filter(Boolean)
      : [];
    if (episodeSummaries.length > 1) {
      const uniqueSummaries = new Set(episodeSummaries);
      if (uniqueSummaries.size < episodeSummaries.length) {
        normalizedReview.status = 'revise';
        const detail = '에피소드 요약이 서로 중복됨. 회차별 사건을 분명히 구분해 주세요.';
        normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
          ? [...normalizedReview.must_fix, detail]
          : [detail];
        normalizedReview.issues = Array.isArray(normalizedReview.issues)
          ? normalizedReview.issues
          : [];
        normalizedReview.issues.push({ type: 'structure', detail });
      }
    }

    const ageProfile = getAgeProfile(state.plan?.target_age_range);
    if (Array.isArray(state.plan?.characters) && state.plan.characters.length > ageProfile.maxCharacters) {
      normalizedReview.status = 'revise';
      const detail = `등장인물 수가 연령 제한을 초과함 (최대 ${ageProfile.maxCharacters}명).`;
      normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
        ? [...normalizedReview.must_fix, detail]
        : [detail];
      normalizedReview.issues = Array.isArray(normalizedReview.issues)
        ? normalizedReview.issues
        : [];
      normalizedReview.issues.push({ type: 'characters', detail });
    }

    if (!String(state.plan?.coverage_scope || '').trim()) {
      normalizedReview.status = 'revise';
      const detail = 'coverage_scope가 비어 있음. 원전에서 다룰 범위를 짧게 명시해야 함.';
      normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
        ? [...normalizedReview.must_fix, detail]
        : [detail];
      normalizedReview.issues = Array.isArray(normalizedReview.issues)
        ? normalizedReview.issues
        : [];
      normalizedReview.issues.push({ type: 'clarity', detail });
    }

    const format = String(state.plan?.format || '').toLowerCase();
    const lengthTier = String(state.plan?.length_tier || '').toLowerCase();
    const episodeCount = Number(state.plan?.episode_count || 0);
    const isSeries = format === 'series';
    if (state.input.length && state.input.length !== 'auto') {
      if (state.input.length === 'series' && format !== 'series') {
        normalizedReview.status = 'revise';
        const detail = '사용자 입력 length=series 인데 format이 series가 아님.';
        normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
          ? [...normalizedReview.must_fix, detail]
          : [detail];
        normalizedReview.issues = Array.isArray(normalizedReview.issues)
          ? normalizedReview.issues
          : [];
        normalizedReview.issues.push({ type: 'format', detail });
      }
      if (['short', 'medium', 'long'].includes(state.input.length) && format !== 'single') {
        normalizedReview.status = 'revise';
        const detail = '사용자 입력 length=short/medium/long 인데 format이 single이 아님.';
        normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
          ? [...normalizedReview.must_fix, detail]
          : [detail];
        normalizedReview.issues = Array.isArray(normalizedReview.issues)
          ? normalizedReview.issues
          : [];
        normalizedReview.issues.push({ type: 'format', detail });
      }
    }
    if (!['single', 'series'].includes(format)) {
      normalizedReview.status = 'revise';
      const detail = 'format은 single 또는 series 여야 함.';
      normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
        ? [...normalizedReview.must_fix, detail]
        : [detail];
      normalizedReview.issues = Array.isArray(normalizedReview.issues)
        ? normalizedReview.issues
        : [];
      normalizedReview.issues.push({ type: 'structure', detail });
    }
    if (isSeries) {
      if (lengthTier !== 'series') {
        normalizedReview.status = 'revise';
        const detail = 'format=series인 경우 length_tier는 "series"여야 함.';
        normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
          ? [...normalizedReview.must_fix, detail]
          : [detail];
        normalizedReview.issues = Array.isArray(normalizedReview.issues)
          ? normalizedReview.issues
          : [];
        normalizedReview.issues.push({ type: 'structure', detail });
      }
      if (episodeCount < 3 || episodeCount > 8) {
        normalizedReview.status = 'revise';
        const detail = '시리즈 회차 수는 3~8편으로 구성해야 함.';
        normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
          ? [...normalizedReview.must_fix, detail]
          : [detail];
        normalizedReview.issues = Array.isArray(normalizedReview.issues)
          ? normalizedReview.issues
          : [];
        normalizedReview.issues.push({ type: 'structure', detail });
      }
    } else if (format === 'single') {
      if (!['short', 'medium', 'long'].includes(lengthTier)) {
        normalizedReview.status = 'revise';
        const detail = 'format=single인 경우 length_tier는 short/medium/long 중 하나여야 함.';
        normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
          ? [...normalizedReview.must_fix, detail]
          : [detail];
        normalizedReview.issues = Array.isArray(normalizedReview.issues)
          ? normalizedReview.issues
          : [];
        normalizedReview.issues.push({ type: 'structure', detail });
      }
      if (episodeCount !== 1) {
        normalizedReview.status = 'revise';
        const detail = 'format=single인 경우 episode_count는 1이어야 함.';
        normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
          ? [...normalizedReview.must_fix, detail]
          : [detail];
        normalizedReview.issues = Array.isArray(normalizedReview.issues)
          ? normalizedReview.issues
          : [];
        normalizedReview.issues.push({ type: 'structure', detail });
      }
    }

    const history = [...(state.planReviewHistory ?? []), normalizedReview];

    return {
      planReview: normalizedReview,
      planReviewHistory: history,
      planIteration: (state.planIteration ?? 0) + 1,
      episodeCount: state.plan?.episode_count ?? state.episodeCount,
    };
  });

  graph.addNode('plan_revise_step', async (state) => {
    const revised = await invokeTwoStage(
      planner,
      planRevisePrompt({ plan: state.plan, review: state.planReview, input: state.input }),
      'plan_revise',
      PlanSchema
    );
    const normalized = normalizePlan(revised, state.input);
    return {
      plan: normalized,
      episodeCount: normalized.episode_count,
      episodeIndex: 1,
    };
  });

  graph.addNode('draft_step', async (state) => {
    const episodeIndex = state.episodeIndex ?? 1;
    const episodeCount = state.episodeCount ?? 1;
    const isFinal = episodeIndex === episodeCount;
    const lengthTarget = getLengthTarget(
      state.plan?.target_age_range,
      state.plan?.length_type
    );
    const response = await writer.invoke(
      draftPrompt({
        plan: state.plan,
        episodeIndex,
        episodeCount,
        isFinal,
        lengthTarget,
      })
    );
    return {
      draft: response.content.trim(),
      critic: undefined,
    };
  });

  graph.addNode('critic_step', async (state) => {
    const episodeIndex = state.episodeIndex ?? 1;
    const episodeCount = state.episodeCount ?? 1;
    const lengthTarget = getLengthTarget(
      state.plan?.target_age_range,
      state.plan?.length_type
    );
    const lengthMetrics = measureLength(state.draft ?? '');
    const review = await invokeTwoStage(
      reviewer,
      criticPrompt({
        plan: state.plan,
        draft: state.draft,
        episodeIndex,
        episodeCount,
        lengthTarget,
      }),
      'critic',
      CriticSchema,
      { useStructured: false }
    );

    const lengthCheck = checkLength(lengthMetrics, lengthTarget);
    const normalizedReview = {
      ...review,
      status: String(review?.status || 'fail').toLowerCase(),
      length_metrics: lengthMetrics,
      length_target: lengthTarget,
    };

    if (!lengthCheck.ok && lengthCheck.severity === 'hard') {
      normalizedReview.status = 'fail';
      normalizedReview.reasons = Array.isArray(normalizedReview.reasons)
        ? [...normalizedReview.reasons, '길이가 목표 범위를 크게 벗어남.']
        : ['길이가 목표 범위를 크게 벗어남.'];
    }

    return {
      critic: normalizedReview,
      criticIteration: (state.criticIteration ?? 0) + 1,
      currentMeta: {
        episode: episodeIndex,
        iteration: (state.criticIteration ?? 0) + 1,
        length_metrics: lengthMetrics,
        length_target: lengthTarget,
        critic: normalizedReview,
      },
    };
  });

  graph.addNode('rewrite_step', async (state) => {
    const lengthTarget = getLengthTarget(
      state.plan?.target_age_range,
      state.plan?.length_type
    );
    const response = await writer.invoke(
      rewritePrompt({
        plan: state.plan,
        draft: state.draft,
        critic: state.critic,
        lengthTarget,
      })
    );
    return {
      draft: response.content.trim(),
    };
  });

  graph.addNode('editor_step', async (state) => {
    const episodeIndex = state.episodeIndex ?? 1;
    const episodeCount = state.episodeCount ?? 1;
    const styleReference = episodeIndex > 1
      ? getStyleSample((state.drafts ?? [])[episodeIndex - 2])
      : '';
    const response = await reviewer.invoke(
      editorPrompt({
        plan: state.plan,
        draft: state.draft,
        episodeIndex,
        episodeCount,
        styleReference,
      })
    );
    return {
      editedDraft: response.content.trim(),
    };
  });

  graph.addNode('collect_step', async (state) => {
    const lengthTarget = getLengthTarget(
      state.plan?.target_age_range,
      state.plan?.length_type
    );
    const lengthMetrics = measureLength(state.editedDraft ?? '');
    const lengthCheck = checkLength(lengthMetrics, lengthTarget);
    const meta = {
      episode: state.episodeIndex ?? 1,
      iteration: state.criticIteration ?? 0,
      length_metrics: lengthMetrics,
      length_target: lengthTarget,
      length_ok: lengthCheck.ok,
      critic: state.critic,
    };
    const drafts = [...(state.drafts ?? []), state.editedDraft ?? ''];
    const episodeMeta = [...(state.episodeMeta ?? []), meta];
    return {
      drafts,
      draft: undefined,
      critic: undefined,
      criticIteration: 0,
      editedDraft: undefined,
      episodeIndex: (state.episodeIndex ?? 1) + 1,
      episodeMeta,
    };
  });

  graph.addEdge(START, 'prepare_step');
  graph.addEdge('prepare_step', 'plan_review_step');
  graph.addEdge('plan_revise_step', 'plan_review_step');
  graph.addEdge('draft_step', 'critic_step');
  graph.addEdge('rewrite_step', 'critic_step');
  graph.addEdge('editor_step', 'collect_step');

  graph.addConditionalEdges('plan_review_step', (state) => {
    const status = String(state.planReview?.status || 'revise').toLowerCase();
    const limit = state.input.planMaxIterations ?? DEFAULT_PLAN_MAX_ITERATIONS;
    if (status === 'pass' || (state.planIteration ?? 0) >= limit) {
      return 'draft_step';
    }
    return 'plan_revise_step';
  }, ['draft_step', 'plan_revise_step']);

  graph.addConditionalEdges('critic_step', (state) => {
    const status = String(state.critic?.status || 'fail').toLowerCase();
    const limit = Math.min(state.input.maxIterations ?? 2, 2);
    if (status === 'pass' || (state.criticIteration ?? 0) >= limit) {
      return 'editor_step';
    }
    return 'rewrite_step';
  }, ['rewrite_step', 'editor_step']);

  graph.addConditionalEdges('collect_step', (state) => {
    const nextIndex = state.episodeIndex ?? 1;
    const count = state.episodeCount ?? 1;
    if (nextIndex <= count) return 'draft_step';
    return END;
  }, ['draft_step', END]);

  return graph.compile();
};

const assembleMarkdown = ({ plan, drafts, storyId, metaPath, lengthStats, readTime }) => {
  const tags = Array.isArray(plan.tags) ? plan.tags : [];
  const tagLine = tags.length ? `[${tags.map(escapeYaml).join(', ')}]` : '[]';
  const totalReadTime = Number(readTime?.total_minutes) || undefined;
  const storyTitle = plan.story_title || plan.title || '';
  const versionTitle = plan.version_title || '';
  const titleOverride = versionTitle && versionTitle !== storyTitle ? versionTitle : '';

  const frontmatter = [
    '---',
    `id: ${escapeYaml(plan.id || `ver_${Date.now()}`)}`,
    `story_id: ${escapeYaml(storyId || '')}`,
    `title: ${escapeYaml(storyTitle)}`,
    titleOverride ? `title_override: ${escapeYaml(titleOverride)}` : null,
    `summary: ${escapeYaml(plan.version_summary || plan.story_summary || plan.summary || '')}`,
    `age_range: ${escapeYaml(plan.target_age_range || '')}`,
    `length_type: ${escapeYaml(plan.length_type || 'short')}`,
    `pipeline_version: ${escapeYaml(PIPELINE_VERSION)}`,
    totalReadTime ? `estimated_read_time: ${totalReadTime}` : null,
    lengthStats ? `actual_char_count: ${lengthStats.char_count_no_space}` : null,
    lengthStats ? `actual_word_count: ${lengthStats.word_count}` : null,
    lengthStats ? `actual_sentence_count: ${lengthStats.sentence_count}` : null,
    metaPath ? `generation_meta_path: ${escapeYaml(metaPath)}` : null,
    `tags: ${tagLine}`,
    '---',
  ].filter(Boolean);

  let body = '';
  if (plan.length_type === 'series') {
    body = drafts
      .map((draft, index) => {
        const episodeTime = Array.isArray(readTime?.per_episode_minutes)
          ? readTime.per_episode_minutes[index]
          : undefined;
        const lines = [
          `### ${index + 1}화`,
          episodeTime ? `- estimated_read_time: ${episodeTime}` : null,
          draft.trim(),
        ].filter(Boolean);
        return lines.join('\n');
      })
      .join('\n\n');
  } else {
    body = drafts[0]?.trim() ?? '';
  }

  return `${frontmatter.join('\n')}\n${body}\n`;
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (!args.title && !args.synopsis && !args.synopsisFile) {
    throw new Error('Provide --title or --synopsis (or --synopsis-file).');
  }

  if (args.synopsisFile) {
    args.synopsis = fs.readFileSync(path.resolve(process.cwd(), args.synopsisFile), 'utf-8');
  }

  const allowedLengths = new Set(['auto', 'short', 'medium', 'long', 'series']);
  const allowedAges = new Set(['', '3-5', '6-7', '8-9']);

  if (!allowedLengths.has(args.length)) {
    throw new Error(`--length must be one of: ${Array.from(allowedLengths).join(', ')}`);
  }

  if (!allowedAges.has(args.age)) {
    throw new Error(`--age must be one of: 3-5, 6-7, 8-9`);
  }

  if (args.episodes && (!Number.isFinite(args.episodes) || args.episodes < 1)) {
    throw new Error('--episodes must be a positive number.');
  }

  if (Number.isNaN(args.maxIterations) || args.maxIterations < 1) {
    throw new Error('--max-iterations must be a positive number.');
  }


  if (Number.isNaN(args.planMaxIterations) || args.planMaxIterations < 1) {
    throw new Error('--plan-max-iterations must be a positive number.');
  }

  ensureTracing(args);
  const models = buildModels(args);
  const app = buildGraph(models);

  const initialState = {
    input: {
      title: args.title,
      storyTitle: args.storyTitle,
      storyId: args.storyId,
      synopsis: args.synopsis,
      age: args.age,
      length: args.length,
      episodes: args.episodes,
      source: args.source,
      tags: args.tags,
      maxIterations: args.maxIterations,
      planMaxIterations: args.planMaxIterations,
    },
  };

  const result = await app.invoke(initialState, { recursionLimit: 100 });
  const plan = result.plan;
  const drafts = result.drafts ?? [];
  const episodeMeta = result.episodeMeta ?? [];
  const planReviewHistory = result.planReviewHistory ?? [];

  if (!plan || drafts.length === 0) {
    throw new Error('Story generation failed: empty plan or draft.');
  }

  const stories = loadStories();
  let storyEntry = null;

  if (args.storyId) {
    storyEntry = stories.find((entry) => entry.id === args.storyId) ?? null;
  }
  if (!storyEntry && plan.story_title) {
    storyEntry = stories.find((entry) => entry.title === plan.story_title) ?? null;
  }
  if (!storyEntry && args.storyTitle) {
    storyEntry = stories.find((entry) => entry.title === args.storyTitle) ?? null;
  }
  if (!storyEntry && args.title) {
    storyEntry = stories.find((entry) => entry.title === args.title) ?? null;
  }
  if (!storyEntry && args.source) {
    storyEntry = stories.find((entry) => entry.title === args.source) ?? null;
  }

  const storyId = storyEntry?.id || args.storyId || nextStoryId(stories);
  const storyTitle =
    storyEntry?.title || plan.story_title || args.storyTitle || args.title || args.source || 'Untitled';
  const storySummary =
    storyEntry?.summary || plan.story_summary || plan.summary || args.synopsis || '';
  const storyTags = Array.from(
    new Set([
      ...(Array.isArray(storyEntry?.tags) ? storyEntry.tags : []),
      ...(Array.isArray(plan.tags) ? plan.tags : []),
    ])
  );

  plan.story_title = storyTitle;
  plan.story_summary = storySummary;
  if (!plan.version_title) {
    plan.version_title = '';
  }

  plan.id = plan.id || nextVersionId(storyId, stories);

  if (!storyEntry) {
    stories.push({
      id: storyId,
      title: storyTitle,
      summary: storySummary,
      tags: storyTags,
      versions: [plan.id],
    });
  } else {
    storyEntry.title = storyTitle;
    storyEntry.summary = storyEntry.summary || storySummary;
    storyEntry.tags = storyTags.length ? storyTags : storyEntry.tags;
    storyEntry.versions = Array.isArray(storyEntry.versions) ? storyEntry.versions : [];
    if (!storyEntry.versions.includes(plan.id)) {
      storyEntry.versions.push(plan.id);
    }
  }

  const slugBase =
    slugifyAscii(args.slug) ||
    slugifyAscii(plan.story_slug_en) ||
    slugifyAscii(storyTitle) ||
    `story-${storyId.replace(/\D/g, '') || Date.now()}`;
  const outputPath = resolveOutputPath({
    slug: slugBase,
    ageRange: plan.target_age_range,
    lengthType: plan.length_type,
    output: args.output,
  });

  const metaFileName = `${slugBase}__${plan.target_age_range}__${plan.length_type}.json`;
  const metaFilePath = path.join(PIPELINE_META_DIR, metaFileName);
  const metaPathForFrontmatter = path.relative(process.cwd(), metaFilePath);
  const lengthStats = aggregateLengthMetrics(episodeMeta) ?? measureLength(drafts.join('\n\n'));
  const readTime = await estimateReadTime({
    model: models.reviewer,
    plan,
    drafts,
    lengthStats,
  });
  const markdown = assembleMarkdown({
    plan,
    drafts,
    storyId,
    metaPath: metaPathForFrontmatter,
    lengthStats,
    readTime,
  });

  if (!args.dryRun) {
    if (!args.overwrite && fs.existsSync(outputPath)) {
      throw new Error(`File already exists: ${outputPath}`);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, markdown, 'utf-8');
    fs.mkdirSync(path.dirname(metaFilePath), { recursive: true });
    const metaPayload = {
      generated_at: new Date().toISOString(),
      model: args.model,
      reasoning_effort: DEFAULT_REASONING_EFFORT,
      pipeline_version: PIPELINE_VERSION,
      input: {
        title: args.title,
        story_title: args.storyTitle,
        story_id: args.storyId,
        synopsis: args.synopsis,
        age: args.age,
        length: args.length,
        episodes: args.episodes,
        source: args.source,
        tags: args.tags,
      },
      plan,
      plan_reviews: planReviewHistory,
      episodes: episodeMeta,
      output: {
        output_path: path.relative(process.cwd(), outputPath),
        meta_path: metaPathForFrontmatter,
        length_stats: lengthStats,
        read_time: readTime,
      },
    };
    fs.writeFileSync(metaFilePath, JSON.stringify(metaPayload, null, 2), 'utf-8');
    saveStories(stories);
  }

  const episodeCount = plan.episode_count ?? drafts.length;
  console.log(`Generated: ${plan.story_title || plan.title}`);
  console.log(`Age: ${plan.target_age_range} | Length: ${plan.length_type} | Episodes: ${episodeCount}`);
  console.log(`Output: ${args.dryRun ? '(dry-run)' : outputPath}`);
  console.log(`Story: ${plan.story_title} (${plan.id})`);
  console.log(`Meta: ${args.dryRun ? '(dry-run)' : metaPathForFrontmatter}`);
  console.log(`Stories index: ${args.dryRun ? '(dry-run)' : STORIES_PATH}`);

  if (!args.noTracing && !process.env.LANGSMITH_TRACING && !process.env.LANGCHAIN_TRACING_V2) {
    console.log('Tracing: disabled (set LANGCHAIN_TRACING_V2=true + LANGCHAIN_API_KEY, or LANGSMITH_TRACING=true + LANGSMITH_API_KEY)');
  }

  if (args.print) {
    console.log('\n' + markdown);
  }
};

run().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
