# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the Astro app.
  - `src/pages/` defines routes (`index.astro`, `stories/`, `read/`).
  - `src/layouts/` holds shared layouts (`BaseLayout.astro`, `ReaderLayout.astro`).
  - `src/lib/content.ts` loads Markdown content and builds excerpts.
  - `src/styles/global.css` contains all styling.
- `content/versions/` holds **one story version per file** (Markdown + frontmatter).
- `tests/` contains Vitest tests.
- `docs/` contains product/UX specifications and content references.

## Build, Test, and Development Commands
- `npm install` — install dependencies.
- `ASTRO_TELEMETRY_DISABLED=1 npm run dev -- --host 127.0.0.1 --port 4321` — run the local dev server.
- `npm run build` — build the static site to `dist/`.
- `npm run preview` — preview the production build locally.
- `npm test` — run Vitest tests.

## Coding Style & Naming Conventions
- Use **2-space indentation** and keep formatting consistent with existing files.
- TypeScript uses semicolons and explicit typing where helpful.
- Content files follow the slug pattern: `content/versions/<title-slug>__<age>__<length>.md`.
- Frontmatter keys use snake_case (e.g., `estimated_read_time`).

## Testing Guidelines
- Test framework: **Vitest**.
- Tests live in `tests/*.test.ts`.
- When changing content loading or parsing, update/add tests accordingly.
- Run `npm test` before pushing.

## Commit & Pull Request Guidelines
- Commit messages use an **imperative title + body**. Example:
  - `Set up Astro app and core UI`
  - Blank line
  - `Implement content loader, pages, and reader UX improvements.`
- PRs should include:
  - Summary of changes
  - Linked issue (if any)
  - Screenshots or recordings for UI changes
  - Notes about any data/content updates

## Content Authoring Notes
- Each version file includes frontmatter plus Markdown body.
- Series content uses chapter headings:
  - `### 1화`
  - Optional `- estimated_read_time: 5`
- Avoid embedding metadata lines in prose; keep them as frontmatter or chapter meta.
