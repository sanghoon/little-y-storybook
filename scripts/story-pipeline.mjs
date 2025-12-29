#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import YAML from 'yaml';
import { ChatOpenAI } from '@langchain/openai';
import { StateGraph, START, END } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

const DEFAULT_MODEL = process.env.STORY_MODEL ?? 'gpt-5.2';
const DEFAULT_REASONING_EFFORT = process.env.REASONING_EFFORT ?? 'medium';
const DEFAULT_PLAN_MAX_ITERATIONS = Number(process.env.PLAN_MAX_ITERATIONS ?? 2);
const DEFAULT_MIN_ITERATIONS = Number(process.env.MIN_REVIEW_ITERATIONS ?? 2);
// Bump this when prompts or pipeline logic change materially.
const PIPELINE_VERSION = 'v1';
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
  --mode "original|adapt|auto" Story mode (auto defaults to original unless source provided)
  --source "..."              Source story title when adapting
  --tags "tag1,tag2"          Comma-separated tags
  --model "gpt-5.2"            Override model (default: ${DEFAULT_MODEL})
  --max-iterations "N"         Review/revise loop limit (default: 3)
  --min-iterations "N"         Minimum review iterations even if passing (default: ${DEFAULT_MIN_ITERATIONS})
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
    mode: 'auto',
    source: '',
    tags: [],
    model: DEFAULT_MODEL,
    maxIterations: 5,
    minIterations: DEFAULT_MIN_ITERATIONS,
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
      case 'mode':
        args.mode = value;
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
      case 'min-iterations':
        args.minIterations = Number(value);
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

const slugify = (value) => {
  const base = String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return base || `story-${Date.now()}`;
};

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

const countDidacticTokens = (value) => {
  const tokens = ['교육', '교훈', '훈련', '습관', '규칙', '예절'];
  const text = String(value ?? '');
  return tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
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

const normalizeJsonLike = (text) => {
  const cleaned = stripFences(text);
  const match = cleaned.match(/\{[\s\S]*\}/) || cleaned.match(/\[[\s\S]*\]/);
  if (!match) return '';
  const sanitized = match[0]
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
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
  const system = `You are a senior Korean children's literature planner and editor specializing in read-aloud storybooks.\n\nRules:\n- Take time to think carefully before answering.\n- Purpose: create a high-quality read-aloud storybook text for children.\n- Write in Korean.\n- This is a read-aloud story. Do NOT rely on illustrations; the text must carry the story on its own.\n- Provide a canonical story_title used for all versions. Keep it stable and short.\n- Set version_title to the same as story_title unless the user explicitly requests a different title.\n- story_summary/version_summary must describe the story content only (no production notes like ‘낭독용/부작/각색/버전’).\n- Provide story_slug_en as lowercase ASCII kebab-case (e.g., alice-in-wonderland). No non-ASCII.\n- Do NOT include story_text, full draft text, or any long prose. Planning fields must stay short and single-line.\n- Do NOT include line breaks inside any string values.\n- Use ONLY the keys shown in the schema example; do not add extra keys.
- Use tags from this pool when applicable: 고전각색, 전래동화, 신화, 창작동화, 판타지, 모험, 우정, 성장, 가족, 용기, 마법, 동물, 음악, 유머, 나눔, 희생, 정직, 자존감, 자기이해, 협동, 재치, 지혜, 귀향, 공주, 편견극복, 보은, 의인화.\n- If mode is adapt, list characters and key events, decide whether to adapt or retell directly, and provide an adaptation plan.
- If mode is adapt and it is not a parody/major reinterpretation, keep story_title the same as the source_story title.\n- adaptation_plan should only describe story changes (what to keep/cut/reshape) and key storytelling choices.\n- Keep adaptation_plan concise and story-focused; avoid listing moral lessons, teaching steps, or style checklists.\n- If mode is original, outline setting, characters, and theme; any educational intent should be subtle and story-first (emotional/experiential), not a checklist.\n- Choose length_type (short/medium/long/series). If series, decide episode_count and outline each episode with clear cut points.\n- For series, include per-episode summary and key beats only (no start/end/hook labels). Ensure episodes cover different events (no repetition).
- Define a clear, consistent style_guide (narrator voice, tense, sentence rhythm, dialogue style) that must be kept across all episodes.\n- Respect provided age range, length, or episode count unless it harms suitability.\n- Output ONLY valid JSON (no markdown, no commentary).\n\nOutput schema example:\n{\n  "mode": "original",\n  "source_story": "",\n  "adaptation_needed": false,\n  "adaptation_plan": "",\n  "story_title": "...",\n  "story_summary": "...",\n  "version_title": "...",\n  "version_summary": "...",\n  "story_slug_en": "alice-in-wonderland",\n  "target_age_range": "6-7",\n  "length_type": "short",\n  "episode_count": 1,\n  "tags": ["..."],\n  "characters": ["..."],\n  "setting": "...",\n  "themes": ["..."],\n  "plot_outline": ["..."],\n  "episode_outlines": [{\"episode\": 1, \"title\": \"...\", \"summary\": \"...\", \"beats\": [\"...\"]}],\n  "style_guide": "..."\n}`;

  const payload = {
    title: input.title,
    story_title: input.storyTitle,
    story_id: input.storyId,
    synopsis: input.synopsis,
    age_range: input.age,
    length_type: input.length,
    mode: input.mode,
    source_story: input.source,
    tags: input.tags,
    requested_episodes: input.episodes,
  };

  const human = `STORY REQUEST:\n"""\n${JSON.stringify(payload, null, 2)}\n"""`;
  return [new SystemMessage(system), new HumanMessage(human)];
};

const planReviewPrompt = ({ plan, input, lengthTarget }) => {
  const system = `You are a veteran Korean children's book editor and read-aloud specialist.\n\nRules:\n- Take time to think carefully before answering.\n- Purpose: ensure the plan will produce a high-quality read-aloud storybook.\n- Review the plan for read-aloud suitability, narrative coherence, age fit, and emotional tone.\n- Do NOT push overly simplistic or babyish vocabulary; keep a natural children’s literature tone.\n- This is not a picture book; ensure the text alone carries the story.\n- Flag if story_summary/version_summary includes production notes (낭독용/부작/각색/버전/시리즈/에피소드/분량).\n- Check episode cuts (if series) are logical, distinct, and flow naturally into the next part.\n- Ensure adaptation_plan stays story-focused; flag if it turns into teaching lists or style checklists.\n- If major issues exist, status must be \"revise\".\n- Avoid nitpicking; only flag issues that would matter to a caregiver reading aloud.\n- All fields are required. If none, use null or empty arrays/empty strings.\n- Output ONLY valid JSON (no markdown, no commentary).\n\nOutput schema example:\n{\n  \"status\": \"pass\",\n  \"issues\": [{\"type\": \"structure\", \"detail\": \"...\"}],\n  \"must_fix\": [],\n  \"suggestions\": [],\n  \"plan_alignment\": {\n    \"read_aloud_ok\": true,\n    \"age_fit_ok\": true,\n    \"episode_cuts_ok\": true,\n    \"notes\": \"\"\n  },\n  \"revision_brief\": \"\"\n}`;

  const human = `PLAN REVIEW CONTEXT:\n"""\n${JSON.stringify(
    {
      story_title: plan.story_title,
      story_summary: plan.story_summary,
      version_title: plan.version_title,
      version_summary: plan.version_summary,
      mode: plan.mode,
      target_age_range: plan.target_age_range,
      length_type: plan.length_type,
      episode_count: plan.episode_count,
      characters: plan.characters,
      setting: plan.setting,
      themes: plan.themes,
      plot_outline: plan.plot_outline,
      episode_outlines: plan.episode_outlines,
      style_guide: plan.style_guide,
      adaptation_plan: plan.adaptation_plan,
      length_target: lengthTarget,
      input_constraints: {
        title: input.title,
        synopsis: input.synopsis,
        source: input.source,
        length: input.length,
        episodes: input.episodes,
      },
    },
    null,
    2
  )}\n"""`;

  return [new SystemMessage(system), new HumanMessage(human)];
};

const planRevisePrompt = ({ plan, review, input }) => {
  const system = `You are a senior Korean children's literature planner and editor specializing in read-aloud storybooks.\n\nRules:\n- Take time to think carefully before answering.\n- Purpose: improve the plan so it yields a high-quality read-aloud storybook.\n- Revise the plan using the editor feedback.\n- Keep story_title and story_slug_en stable unless reviewer explicitly requests a change.\n- Preserve the core premise and target age.\n- Keep adaptation_plan concise and story-focused; avoid turning it into a teaching checklist or style list.\n- Output ONLY valid JSON (no markdown, no commentary).`;

  const human = `CURRENT PLAN:\n"""\n${JSON.stringify(plan, null, 2)}\n"""\n\nEDITOR REVIEW:\n"""\n${JSON.stringify(review, null, 2)}\n"""\n\nINPUT:\n"""\n${JSON.stringify(input, null, 2)}\n"""`;

  return [new SystemMessage(system), new HumanMessage(human)];
};

const draftPrompt = ({ plan, episodeIndex, episodeCount, isFinal, lengthTarget, styleReference, previousEpisodeText }) => {
  const system = `You are a Korean children's story writer for read-aloud storybooks.\n\nRules:\n- Take time to think carefully before answering.\n- Purpose: produce a high-quality read-aloud storybook text.\n- Write natural, vivid Korean with no translation-like phrasing.\n- Keep sentences smooth, age-appropriate, and emotionally warm.\n- Follow the plan strictly; avoid 플랜 이탈 from the story's premise, characters, or events.\n- Do NOT introduce new main characters or settings unless explicitly listed in the plan.\n- This is for read-aloud. Do NOT rely on illustrations or visual-only cues.\n- Do NOT include titles, headings, or metadata. Return only the story text.\n- Avoid frequent direct prompts to the listener (e.g., ‘우리도 해봐요’). Keep narration-focused.\n- If this is not the final episode, you may end with a gentle continuation only if it fits naturally; avoid forced hooks or cliffhangers.\n- Avoid slang, forced rhymes, and awkward expressions.\n- Light, natural repetition or a gentle refrain is allowed if it helps read-aloud rhythm.\n- Avoid didactic or list-like teaching; show lessons through actions and dialogue.\n- Do NOT over-simplify vocabulary; use a natural children’s literature tone.\n- Keep length within the target range when possible.
- Follow the style_guide strictly; keep tone and voice consistent with prior episodes.\n\nQuality bar:\n- Read-aloud friendly rhythm and pacing.\n- Clear cause-effect flow.\n- Use occasional patterned phrasing or small refrains to support read-aloud cadence; avoid overuse.\n- No sudden scene jumps unless noted in the plan.`;

  const outline = plan.episode_outlines?.[episodeIndex - 1] ?? {};
  const human = `FULL PLAN (FOLLOW EXACTLY):\n"""\n${JSON.stringify(
    {
      story_title: plan.story_title || plan.title,
      story_summary: plan.story_summary || plan.summary,
      version_title: plan.version_title || plan.title,
      version_summary: plan.version_summary || plan.summary,
      target_age_range: plan.target_age_range,
      length_type: plan.length_type,
      style_guide: plan.style_guide,
      adaptation_plan: plan.adaptation_plan,
      characters: plan.characters,
      setting: plan.setting,
      themes: plan.themes,
      plot_outline: plan.plot_outline,
      episode_count: episodeCount,
      episode_index: episodeIndex,
      episode_outline: outline,
      length_target: lengthTarget,
      is_final_episode: isFinal,
      style_reference: styleReference,
    },
    null,
    2
  )}\n"""`;

  const previousEpisode =
    episodeIndex > 1 ? (previousEpisodeText ?? '') : '';
  const prevBlock = previousEpisode
    ? `\n\nPREVIOUS EPISODE (REFERENCE ONLY, DO NOT REWRITE):\n"""\n${previousEpisode}\n"""`
    : '';

  return [new SystemMessage(system), new HumanMessage(human + prevBlock)];
};

const reviewPrompt = ({ plan, draft, episodeIndex, episodeCount, lengthMetrics, lengthTarget, styleReference }) => {
  const system = `You are a veteran Korean children's book editor and read-aloud specialist.\n\nRules:\n- Take time to think carefully before answering.\n- Purpose: evaluate and refine the draft into a high-quality read-aloud storybook text.\n- Review for consistency, flow, sentence quality, grammar, spelling, and age appropriateness.\n- This must be readable aloud with natural rhythm; translation-like or awkward phrasing is NOT acceptable.\n- Do NOT invent problems; if unsure, do not flag it.\n- Do NOT demand overly simplistic or babyish vocabulary; keep a natural children’s literature tone.\n- This is not a picture book; the text must stand on its own.\n- Avoid didactic, checklist-style teaching; the lesson should feel woven into the story.\n- Flag excessive direct prompts to the listener (e.g., 반복되는 ‘우리도/함께’ 지시).\n- Avoid nitpicking; only flag issues that affect read-aloud quality or story clarity.\n- Check length against the provided target. Only flag it if it is significantly outside the range.\n- Verify the draft follows the plan: characters, setting, and outlined events. Detect 플랜 이탈.
- Ensure the draft matches the style_guide and is consistent with the style_reference.\n- When you flag an issue, include a short evidence snippet (<=12 words) from the draft. If you cannot cite evidence, do NOT flag it.\n- If any major issue exists, status must be "revise".\n- All fields are required. If none, use null or empty arrays/empty strings.\n- Output ONLY valid JSON (no markdown, no commentary).\n\nOutput schema example:\n{\n  \"status\": \"pass\",\n  \"issues\": [{\"type\": \"consistency\", \"detail\": \"...\", \"evidence\": \"...\"}],\n  \"must_fix\": [],\n  \"suggestions\": [],\n  \"plan_alignment\": {\n    \"characters_ok\": true,\n    \"setting_ok\": true,\n    \"outline_covered\": true,\n    \"plan_deviation\": false,\n    \"notes\": \"\"\n  }\n}`;

  const human = `CONTEXT:\n"""\n${JSON.stringify(
    {
      story_title: plan.story_title || plan.title,
      target_age_range: plan.target_age_range,
      characters: plan.characters,
      setting: plan.setting,
      story_summary: plan.story_summary || plan.summary,
      plot_outline: plan.plot_outline,
      episode_outline: plan.episode_outlines?.[episodeIndex - 1] ?? {},
      episode_index: episodeIndex,
      episode_count: episodeCount,
      length_target: lengthTarget,
      length_metrics: lengthMetrics,
      style_guide: plan.style_guide,
      style_reference: styleReference,
      adaptation_plan: plan.adaptation_plan,
    },
    null,
    2
  )}\n"""\n\nDRAFT:\n"""\n${draft}\n"""`;

  return [new SystemMessage(system), new HumanMessage(human)];
};

const revisePrompt = ({ plan, draft, review, lengthTarget, lengthMetrics }) => {
  const system = `You are a Korean children's story writer for read-aloud storybooks.\n\nRules:\n- Take time to think carefully before answering.\n- Purpose: produce a polished read-aloud storybook text.\n- Apply the editor feedback precisely.\n- Preserve the story's intent and emotional tone.\n- Avoid 플랜 이탈 from the plan (characters, setting, events).\n- Remove didactic, list-like teaching if present; keep lessons embedded in action/dialogue.\n- Keep the length within the target range when possible.\n- Return only the revised story text (no headings, no metadata).`;

  const human = `FULL PLAN (MUST FOLLOW):\n"""\n${JSON.stringify(
    {
      story_title: plan.story_title || plan.title,
      story_summary: plan.story_summary || plan.summary,
      version_title: plan.version_title || plan.title,
      version_summary: plan.version_summary || plan.summary,
      target_age_range: plan.target_age_range,
      style_guide: plan.style_guide,
      adaptation_plan: plan.adaptation_plan,
      characters: plan.characters,
      setting: plan.setting,
      themes: plan.themes,
      plot_outline: plan.plot_outline,
      length_target: lengthTarget,
      length_metrics: lengthMetrics,
    },
    null,
    2
  )}\n"""\n\nEDITOR FEEDBACK:\n"""\n${JSON.stringify(review, null, 2)}\n"""\n\nDRAFT:\n"""\n${draft}\n"""`;

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
  const mode = input.mode === 'auto'
    ? input.source ? 'adapt' : 'original'
    : input.mode;

  normalized.mode = normalized.mode || mode;
  normalized.source_story = normalized.source_story || input.source || '';
  normalized.story_title = sanitizeLine(
    normalized.story_title || input.storyTitle || input.title || input.source || 'Untitled'
  );
  normalized.story_summary = sanitizeLine(
    normalized.story_summary || normalized.summary || input.synopsis || ''
  );
  normalized.version_title = sanitizeLine(
    normalized.version_title || normalized.title || ''
  );
  if (input.storyTitle || input.storyId) {
    normalized.version_title = normalized.story_title;
  }
  normalized.version_summary = sanitizeLine(
    normalized.version_summary || normalized.summary || normalized.story_summary
  );
  normalized.story_slug_en = sanitizeLine(
    normalized.story_slug_en || ''
  );
  if (!normalized.story_slug_en || /[^\x00-\x7F]/.test(normalized.story_slug_en)) {
    normalized.story_slug_en = slugifyAscii(normalized.story_title);
  }
  normalized.title = normalized.story_title;
  normalized.target_age_range = input.age || normalized.target_age_range || '6-7';
  normalized.length_type = input.length !== 'auto'
    ? input.length
    : normalized.length_type || 'short';

  const plotEvents = Array.isArray(normalized.plot_outline)
    ? normalized.plot_outline.length
    : 0;

  if (input.length === 'auto' && normalized.mode === 'adapt' && plotEvents >= 4) {
    normalized.length_type = 'series';
  }

  if (input.episodes) {
    normalized.length_type = 'series';
    normalized.episode_count = input.episodes;
  }

  const isSeries = normalized.length_type === 'series';
  const baseEpisodeCount = plotEvents >= 6 ? 4 : plotEvents >= 4 ? 3 : 2;
  const episodeCount = Number(
    normalized.episode_count || (isSeries ? clamp(baseEpisodeCount, 2, 5) : 1)
  );
  normalized.episode_count = isSeries ? clamp(episodeCount, 2, 6) : 1;

  const episodeOutlines = Array.isArray(normalized.episode_outlines)
    ? normalized.episode_outlines
    : [];

  const normalizeOutline = (outline, index) => {
    const beats = Array.isArray(outline?.beats) ? outline.beats : [];
    const legacyBeats = [];
    if (outline?.start) legacyBeats.push(outline.start);
    if (outline?.end) legacyBeats.push(outline.end);
    if (outline?.hook) legacyBeats.push(outline.hook);
    return {
      episode: Number(outline?.episode) || index + 1,
      title: String(outline?.title || `${normalized.story_title} ${index + 1}화`),
      summary: String(outline?.summary || normalized.story_summary || ''),
      beats: beats.length ? beats : legacyBeats,
    };
  };

  if (episodeOutlines.length !== normalized.episode_count) {
    normalized.episode_outlines = Array.from({ length: normalized.episode_count }, (_, index) =>
      normalizeOutline({}, index)
    );
  } else {
    normalized.episode_outlines = episodeOutlines.map((outline, index) =>
      normalizeOutline(outline, index)
    );
  }

  if (!Array.isArray(normalized.tags)) {
    normalized.tags = [];
  }

  if (input.tags.length) {
    normalized.tags = Array.from(new Set([...normalized.tags, ...input.tags]));
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
  review: z.any().optional(),
  iteration: z.number().optional(),
  currentMeta: z.any().optional(),
  episodeMeta: z.array(z.any()).optional(),
});

const PlanSchema = z.object({
  mode: z.string(),
  source_story: z.string(),
  adaptation_needed: z.boolean(),
  adaptation_plan: z.string(),
  story_title: z.string(),
  story_summary: z.string(),
  version_title: z.string(),
  version_summary: z.string(),
  story_slug_en: z.string(),
  target_age_range: z.string(),
  length_type: z.string(),
  episode_count: z.number(),
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
  style_guide: z.string(),
});

const PlanReviewSchema = z.object({
  status: z.string(),
  issues: z.array(z.object({ type: z.string(), detail: z.string() })).nullable(),
  must_fix: z.array(z.string()).nullable(),
  suggestions: z.array(z.string()).nullable(),
  plan_alignment: z
    .object({
      read_aloud_ok: z.boolean(),
      age_fit_ok: z.boolean(),
      episode_cuts_ok: z.boolean(),
      notes: z.string(),
    })
    .nullable(),
  revision_brief: z.string().nullable(),
});

const ReviewSchema = z.object({
  status: z.string(),
  issues: z
    .array(z.object({ type: z.string(), detail: z.string(), evidence: z.string().nullable() }))
    .nullable(),
  must_fix: z.array(z.string()).nullable(),
  suggestions: z.array(z.string()).nullable(),
  plan_alignment: z
    .object({
      characters_ok: z.boolean(),
      setting_ok: z.boolean(),
      outline_covered: z.boolean(),
      plan_deviation: z.boolean(),
      notes: z.string(),
    })
    .nullable(),
});

const ReadTimeSchema = z.object({
  total_minutes: z.number(),
  per_episode_minutes: z.array(z.number()),
});

const buildGraph = ({ planner, writer, reviewer }) => {
  const graph = new StateGraph(StoryState);

  graph.addNode('prepare_step', async (state) => {
    let plan;
    if (typeof planner.withStructuredOutput === 'function') {
      const structured = planner.withStructuredOutput(PlanSchema);
      plan = await structured.invoke(planPrompt(state.input));
    } else {
      plan = await invokeJson(planner, planPrompt(state.input), 'plan', PlanSchema);
    }
    const normalized = normalizePlan(plan, state.input);
    return {
      plan: normalized,
      planReview: undefined,
      planReviewHistory: [],
      planIteration: 0,
      episodeIndex: 1,
      episodeCount: normalized.episode_count,
      drafts: [],
      iteration: 0,
      episodeMeta: [],
    };
  });

  graph.addNode('plan_review_step', async (state) => {
    const lengthTarget = getLengthTarget(
      state.plan?.target_age_range,
      state.plan?.length_type
    );
    const review = typeof reviewer.withStructuredOutput === 'function'
      ? await reviewer
          .withStructuredOutput(PlanReviewSchema)
          .invoke(planReviewPrompt({ plan: state.plan, input: state.input, lengthTarget }))
      : await invokeJson(
          reviewer,
          planReviewPrompt({ plan: state.plan, input: state.input, lengthTarget }),
          'plan_review',
          PlanReviewSchema
        );

    const normalizedReview = {
      ...review,
      status: String(review?.status || 'revise').toLowerCase(),
    };

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

    const didacticScore = countDidacticTokens(state.plan?.adaptation_plan);
    if (didacticScore >= 3) {
      normalizedReview.status = 'revise';
      const detail = 'adaptation_plan이 교육/교훈 표현 위주로 과하게 작성됨. 서사 속 행동/대화 중심으로 완화 필요.';
      normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
        ? [...normalizedReview.must_fix, detail]
        : [detail];
      normalizedReview.issues = Array.isArray(normalizedReview.issues)
        ? normalizedReview.issues
        : [];
      normalizedReview.issues.push({ type: 'tone', detail });
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
    const revised = typeof planner.withStructuredOutput === 'function'
      ? await planner
          .withStructuredOutput(PlanSchema)
          .invoke(planRevisePrompt({ plan: state.plan, review: state.planReview, input: state.input }))
      : await invokeJson(
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
    const previousEpisodeText = episodeIndex > 1
      ? (state.drafts ?? [])[episodeIndex - 2]
      : '';
    const styleReference = episodeIndex > 1
      ? getStyleSample(previousEpisodeText)
      : '';
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
        styleReference,
        previousEpisodeText,
      })
    );
    return {
      draft: response.content.trim(),
      review: undefined,
    };
  });

  graph.addNode('review_step', async (state) => {
    const episodeIndex = state.episodeIndex ?? 1;
    const episodeCount = state.episodeCount ?? 1;
    const styleReference = episodeIndex > 1
      ? getStyleSample((state.drafts ?? [])[episodeIndex - 2])
      : '';
    const lengthTarget = getLengthTarget(
      state.plan?.target_age_range,
      state.plan?.length_type
    );
    const lengthMetrics = measureLength(state.draft ?? '');
    const review = typeof reviewer.withStructuredOutput === 'function'
      ? await reviewer
          .withStructuredOutput(ReviewSchema)
          .invoke(
            reviewPrompt({
              plan: state.plan,
              draft: state.draft,
              episodeIndex,
              episodeCount,
              lengthMetrics,
              lengthTarget,
              styleReference,
            })
          )
      : await invokeJson(
          reviewer,
          reviewPrompt({
            plan: state.plan,
            draft: state.draft,
            episodeIndex,
            episodeCount,
            lengthMetrics,
            lengthTarget,
            styleReference,
          }),
          'review',
          ReviewSchema
        );

    const lengthCheck = checkLength(lengthMetrics, lengthTarget);
    const normalizedReview = {
      ...review,
      status: String(review?.status || 'revise').toLowerCase(),
      length_ok: lengthCheck.ok,
      length_metrics: lengthMetrics,
      length_target: lengthTarget,
    };

    const repeated = findOverRepeatedSentences(state.draft ?? '', 3);
    if (repeated.length) {
      normalizedReview.status = 'revise';
      const detail = `같은 문장이 과도하게 반복됨: ${repeated[0].sentence} (x${repeated[0].count})`;
      normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
        ? [...normalizedReview.must_fix, detail]
        : [detail];
      normalizedReview.issues = Array.isArray(normalizedReview.issues)
        ? normalizedReview.issues
        : [];
      normalizedReview.issues.push({
        type: 'repetition',
        detail,
        evidence: repeated[0].sentence,
      });
    }

    const listenerPromptCount = countListenerPrompts(state.draft ?? '');
    if (listenerPromptCount >= 2) {
      normalizedReview.status = 'revise';
      const detail = `청자에게 직접 지시하는 표현이 많음 (카운트: ${listenerPromptCount}). 내레이션 중심으로 축소 필요.`;
      const sample = findListenerPromptSample(state.draft ?? '');
      normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
        ? [...normalizedReview.must_fix, detail]
        : [detail];
      normalizedReview.issues = Array.isArray(normalizedReview.issues)
        ? normalizedReview.issues
        : [];
      normalizedReview.issues.push({
        type: 'tone',
        detail,
        evidence: sample || '직접 지시 표현 반복',
      });
    }

    if (!lengthCheck.ok && lengthCheck.severity !== 'soft') {
      const detail = `현재 길이(${lengthCheck.value}자)가 목표 범위(${lengthTarget.min}~${lengthTarget.max}자)를 벗어남.`;
      normalizedReview.status = 'revise';
      normalizedReview.must_fix = Array.isArray(normalizedReview.must_fix)
        ? [...normalizedReview.must_fix, detail]
        : [detail];
      normalizedReview.issues = Array.isArray(normalizedReview.issues)
        ? normalizedReview.issues
        : [];
      normalizedReview.issues.push({
        type: 'length',
        detail,
        evidence: `char_count_no_space=${lengthCheck.value}`,
      });
    }

    return {
      review: normalizedReview,
      iteration: (state.iteration ?? 0) + 1,
      currentMeta: {
        episode: episodeIndex,
        iteration: (state.iteration ?? 0) + 1,
        length_metrics: lengthMetrics,
        length_target: lengthTarget,
        review: normalizedReview,
      },
    };
  });

  graph.addNode('revise_step', async (state) => {
    const lengthTarget = getLengthTarget(
      state.plan?.target_age_range,
      state.plan?.length_type
    );
    const lengthMetrics = state.review?.length_metrics ?? measureLength(state.draft ?? '');
    const response = await writer.invoke(
      revisePrompt({
        plan: state.plan,
        draft: state.draft,
        review: state.review,
        lengthTarget,
        lengthMetrics,
      })
    );
    return {
      draft: response.content.trim(),
    };
  });

  graph.addNode('collect_step', async (state) => {
    const lengthTarget = getLengthTarget(
      state.plan?.target_age_range,
      state.plan?.length_type
    );
    const lengthMetrics = measureLength(state.draft ?? '');
    const lengthCheck = checkLength(lengthMetrics, lengthTarget);
    const meta = {
      episode: state.episodeIndex ?? 1,
      iteration: state.iteration ?? 0,
      length_metrics: lengthMetrics,
      length_target: lengthTarget,
      length_ok: lengthCheck.ok,
      review: state.review,
    };
    const drafts = [...(state.drafts ?? []), state.draft ?? ''];
    const episodeMeta = [...(state.episodeMeta ?? []), meta];
    return {
      drafts,
      draft: undefined,
      review: undefined,
      iteration: 0,
      episodeIndex: (state.episodeIndex ?? 1) + 1,
      episodeMeta,
    };
  });

  graph.addEdge(START, 'prepare_step');
  graph.addEdge('prepare_step', 'plan_review_step');
  graph.addEdge('plan_revise_step', 'plan_review_step');
  graph.addEdge('draft_step', 'review_step');
  graph.addEdge('revise_step', 'review_step');

  graph.addConditionalEdges('plan_review_step', (state) => {
    const status = String(state.planReview?.status || 'revise').toLowerCase();
    const limit = state.input.planMaxIterations ?? DEFAULT_PLAN_MAX_ITERATIONS;
    if (status === 'pass' || (state.planIteration ?? 0) >= limit) {
      return 'draft_step';
    }
    return 'plan_revise_step';
  }, ['draft_step', 'plan_revise_step']);

  graph.addConditionalEdges('review_step', (state) => {
    const status = String(state.review?.status || 'revise').toLowerCase();
    const limit = state.input.maxIterations ?? 3;
    const minIterations = state.input.minIterations ?? DEFAULT_MIN_ITERATIONS;
    if ((state.iteration ?? 0) < minIterations) {
      return 'revise_step';
    }
    if (status === 'pass' || (state.iteration ?? 0) >= limit) {
      return 'collect_step';
    }
    return 'revise_step';
  }, ['revise_step', 'collect_step']);

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
  const allowedModes = new Set(['auto', 'original', 'adapt']);
  const allowedAges = new Set(['', '3-5', '6-7', '8-9']);

  if (!allowedLengths.has(args.length)) {
    throw new Error(`--length must be one of: ${Array.from(allowedLengths).join(', ')}`);
  }

  if (!allowedModes.has(args.mode)) {
    throw new Error(`--mode must be one of: ${Array.from(allowedModes).join(', ')}`);
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

  if (Number.isNaN(args.minIterations) || args.minIterations < 1) {
    throw new Error('--min-iterations must be a positive number.');
  }

  if (args.minIterations > args.maxIterations) {
    throw new Error('--min-iterations must be less than or equal to --max-iterations.');
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
      mode: args.mode,
      source: args.source,
      tags: args.tags,
      maxIterations: args.maxIterations,
      minIterations: args.minIterations,
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
        mode: args.mode,
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
