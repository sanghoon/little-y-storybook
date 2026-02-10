import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';

export type Chapter = {
  title: string;
  estimatedReadTime?: number;
  markdown: string;
  html: string;
  index: number;
};

export type Version = {
  id: string;
  title: string;
  summary: string;
  ageRange: string;
  lengthType: 'short' | 'medium' | 'long' | 'series' | string;
  updatedAt: string;
  updatedAtMs: number;
  estimatedReadTime?: number;
  tags: string[];
  markdown: string;
  html: string;
  chapters?: Chapter[];
  pipelineVersion?: string;
  slug: string;
};

const CONTENT_DIR = path.resolve(process.cwd(), 'content', 'versions');

const toArray = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const toNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const toString = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
};

const toIsoDateString = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
};

const stripMarkdown = (markdown: string) =>
  markdown
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('### ')) return false;
      if (trimmed.startsWith('- estimated_read_time:')) return false;
      return true;
    })
    .join(' ')
    .replace(/[#>*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const renderMarkdown = (markdown: string): string => String(marked.parse(markdown));

export const parseChapters = (markdown: string): Chapter[] => {
  const chunks = markdown.split(/^###\s+/m).filter(Boolean);
  return chunks.map((chunk, index) => {
    const lines = chunk.split('\n');
    const title = lines.shift()?.trim() ?? `회차 ${index + 1}`;
    while (lines[0]?.trim() === '') {
      lines.shift();
    }

    let estimatedReadTime: number | undefined;
    if (lines[0]?.trim().startsWith('- estimated_read_time:')) {
      const value = lines[0].split(':').slice(1).join(':').trim();
      estimatedReadTime = toNumber(value);
      lines.shift();
    }

    while (lines[0]?.trim() === '') {
      lines.shift();
    }

    const body = lines.join('\n').trim();
    return {
      title,
      estimatedReadTime,
      markdown: body,
      html: renderMarkdown(body),
      index: index + 1,
    };
  });
};

export const loadVersions = (): Version[] => {
  const files = fs
    .readdirSync(CONTENT_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort();

  return files.map((file) => {
    const filePath = path.join(CONTENT_DIR, file);
    const stat = fs.statSync(filePath);
    const source = fs.readFileSync(filePath, 'utf-8');
    const { data, content } = matter(source);

    const tags = toArray(data.tags);
    const markdown = content.trim();
    const html = renderMarkdown(markdown);
    const lengthType = String(data.length_type ?? 'short');
    const isSeries = lengthType === 'series';
    const pipelineVersion = toString(data.pipeline_version);
    const updatedAt = toIsoDateString(data.updated_at) ?? stat.mtime.toISOString();
    const updatedAtMs = new Date(updatedAt).getTime();

    return {
      id: String(data.id ?? ''),
      title: String(data.title ?? ''),
      summary: String(data.summary ?? ''),
      ageRange: String(data.age_range ?? ''),
      lengthType,
      updatedAt,
      updatedAtMs,
      estimatedReadTime: toNumber(data.estimated_read_time),
      tags,
      markdown,
      html,
      chapters: isSeries ? parseChapters(markdown) : undefined,
      pipelineVersion,
      slug: file.replace(/\.md$/, ''),
    } satisfies Version;
  });
};

export const loadVersionById = (id: string): Version | undefined =>
  loadVersions().find((version) => version.id === id);

export const loadVersionBySlug = (slug: string): Version | undefined =>
  loadVersions().find((version) => version.slug === slug);

export const getRelatedVersions = (versions: Version[], current: Version) =>
  versions.filter(
    (version) => version.title === current.title && version.id !== current.id
  );

export const getExcerpt = (version: Version, length = 120) => {
  const source = version.summary?.trim() ? version.summary : version.markdown;
  const plain = stripMarkdown(source);
  return plain.length > length ? `${plain.slice(0, length)}…` : plain;
};
