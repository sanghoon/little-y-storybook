# Project Structure Index

## Runtime modules
- `src/lib/content.ts`: Markdown loaders and helpers (`loadVersions`, `loadVersionById/Slug`, `getRelatedVersions`, `getExcerpt`, `parseChapters`).
- `src/layouts/BaseLayout.astro`: Default layout with meta tags, header/nav, and footer.
- `src/layouts/ReaderLayout.astro`: Focused reader layout with back link and reader page shell.
- `src/pages/index.astro`: Home with recent reads injection, recommendations, and quick filters.
- `src/pages/stories/index.astro`: Story list with filters, search, and card rendering.
- `src/pages/stories/[id].astro`: Redirect shim from deprecated detail page to `/read/:id`.
- `src/pages/read/[id].astro`: Unified reading page (metadata, related versions, reader controls/content).
- `src/styles/global.css`: Global theme, layout primitives, cards, chips, reader styles, responsive rules.

## Content & docs
- `content/versions/*.md`: One Markdown file per story version (frontmatter + body).
- `docs/screens/*`: Screen specifications (home/list/reader; detail kept for history).
- `docs/information-architecture.md`: IA and user flows overview.
- `README.md`: Project setup and high-level description.

## Tests
- `tests/content.test.ts`: Content loader/parsing tests.

