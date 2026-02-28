# Repository Guidelines for Agents

This document is for agentic coding tools working in this repository.
Follow existing patterns and keep edits minimal and consistent.

## Project Snapshot
- Framework: Astro (static build)
- Language: TypeScript + ESM ("type": "module")
- Styling: vanilla CSS in `src/styles/global.css`
- Content: Markdown with YAML frontmatter in `content/versions/`
- Tests: Vitest in `tests/*.test.ts`
- Scripts: Node CLI tools in `scripts/`

## Build / Dev / Test Commands
- Install: `npm install`
- Dev server: `ASTRO_TELEMETRY_DISABLED=1 npm run dev -- --host 127.0.0.1 --port 4321`
- Build: `npm run build`
- Preview build: `npm run preview`
- Tests (all): `npm test`
- Tests (single file): `npm test -- tests/content.test.ts`
- Tests (single test by name): `npm test -- -t "parses chapters"`
- Tests (filter by file + name): `npm test -- tests/content.test.ts -t "loads versions"`
- Validate content: `npm run validate:content`
- Generate story content: `npm run generate:story -- --title "..." --synopsis "..."`

## Linting / Formatting
- No dedicated lint/format scripts exist in `package.json`.
- Maintain existing formatting in the touched file.
- Use the same indentation style (2 spaces) and semicolons in TS/JS.

## Astro / UI Structure
- Routes live in `src/pages/` and use frontmatter blocks.
- Layouts live in `src/layouts/`.
- Keep client-side scripts inline where already used (`<script is:inline>`).
- Prefer small, readable DOM helpers over heavy frameworks.
- When inserting JSON into HTML, use `set:html` with escaping to avoid `</script>` breakouts.
- Use `data-` attributes for lightweight client-side state and filtering.

## TypeScript / JavaScript Style
- Use ESM imports (`import ... from ...`).
- Use `node:`-prefixed builtins (e.g., `import fs from 'node:fs'`).
- Prefer `const` and `let` (no `var`).
- Keep functions small and pure when possible.
- Use `satisfies` for structural typing where it improves correctness.
- Be explicit with return shapes for exported helpers.
- Favor guard clauses for early returns over deep nesting.
- Keep inline scripts in Astro minimal and DOM-only (no frameworks).

## Imports & Module Organization
- Group imports by origin: node builtins, external packages, local files.
- Keep import order stable; avoid re-sorting unless touching that block.
- Avoid unused imports; remove them when editing a file.

## Naming Conventions
- Files: kebab-case for content and routes, existing style for scripts.
- Variables: camelCase.
- Types: PascalCase (`Version`, `Chapter`).
- Constants: UPPER_SNAKE_CASE (`CONTENT_DIR`).

## Error Handling
- Prefer explicit errors in CLI scripts (throw with clear message).
- Include context (file path, id, model) in error messages.
- For user-visible warnings, use `console.warn` and keep language concise.
- Avoid silent failures; return `undefined` only when intentional and documented.
- In CLI tools, exit with non-zero status on errors (`process.exit(1)`).

## Content Rules (Markdown)
- One story version per file in `content/versions/`.
- Filename pattern: `content/versions/<slug>__<age>__<length>.md`.
- Frontmatter keys use snake_case (e.g., `estimated_read_time`).
- `length_type` is one of: `short | medium | long | series`.
- Required frontmatter: `id`, `story_id`, `title`, `summary`, `age_range`, `length_type`, `tags`.
- `age_range` must be one of: `3-5 | 6-7 | 8-9`.
- Keep `summary` free of production metadata like "낭독용/버전/시리즈".
- Series chapters use `### 1화` headings with optional `- estimated_read_time:` line.
- Do not embed metadata in prose; keep it in frontmatter or chapter meta.
- Keep content text in Korean; avoid ASCII-only story text.

## Scripts / CLI Conventions
- Scripts live in `scripts/` and are ESM.
- Use YAML for content metadata (`content/stories.yml`).
- Validate content using `npm run validate:content`.
- Story generation uses `npm run generate:story -- --title "..." --synopsis "..."`.
- Keep CLI help text aligned with the actual flags.
- When adding new flags, update help text and validation in the same file.
- Prefer explicit `Error` messages over silent fallbacks.

## Testing Guidelines
- Use Vitest APIs: `describe`, `it`, `expect`.
- Tests import production modules (no test-only wrappers).
- For content loader changes, update `tests/content.test.ts` accordingly.
- For script logic changes, add/extend tests under `tests/` as needed.

## Type Safety / Data Shape Notes
- `src/lib/content.ts` is the canonical loader.
- `Version.lengthType` is a string union plus fallback string.
- `pipelineVersion` is optional and derived from `pipeline_version` frontmatter.
- Ensure `slug` matches filename (without `.md`).
- `tags` are normalized to string arrays.
- `estimated_read_time` accepts numbers or numeric strings (normalized to number).

## Data & Rendering Notes
- Markdown content is converted to HTML via `marked` in `src/lib/content.ts`.
- Excerpts come from `summary` first, then stripped Markdown from body.
- Series chapters are parsed by splitting on `###` headings.
- For Astro pages, compute data in frontmatter; keep template logic readable.
- When adding JSON blobs to HTML, escape `<` to avoid script breakouts.
- Keep text intended for readers in Korean to match existing content tone.

## CSS Guidelines
- All CSS is currently in `src/styles/global.css`.
- Keep class naming consistent with existing `card`, `chip`, `badge` patterns.
- Avoid introducing new global resets unless necessary.
- Prefer extending existing utility patterns over adding new layout systems.

## Environment & Secrets
- `scripts/story-pipeline.mjs` uses API keys from env (`GOOGLE_API_KEY`, etc.).
- Never hardcode credentials or tokens.
- Do not add `.env` files to commits (use `.env.example` as a template).
- If a script requires a key, fail fast with a clear error.
- The repository is public. DO NOT log or expose sensitive credentials in PRs, issues, or commit messages.

## Cursor / Copilot Rules
- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` were found.

## Commit & PR Notes (for agents)
- Follow the repository’s existing commit/PR conventions when asked to commit.
- Avoid amending commits unless explicitly instructed.
- Summaries should describe the final state, not intermediate changes.

## Quick Paths
- App entry: `src/pages/index.astro`
- Stories list: `src/pages/stories/index.astro`
- Reader: `src/pages/read/[id].astro`
- Content loader: `src/lib/content.ts`
- Tests: `tests/`
- Content: `content/versions/`
- Docs: `docs/`
- Story pipeline: `scripts/story-pipeline.mjs`
- Content validator: `scripts/validate-content.mjs`

## Working Style Expectations
- Keep changes scoped to the user request.
- Preserve existing UI/UX tone and Korean copy style.
- When adding features, update related docs/tests if applicable.
- Do not remove existing content or tests unless requested.
