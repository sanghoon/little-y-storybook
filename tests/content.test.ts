import { describe, expect, it } from 'vitest';
import { loadVersions, parseChapters } from '../src/lib/content';

describe('content loader', () => {
  it('loads versions from markdown files', () => {
    const versions = loadVersions();
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0].title).toBeTruthy();
    expect(versions[0].updatedAt).toBeTruthy();
    expect(Number.isFinite(versions[0].updatedAtMs)).toBe(true);
  });

  it('parses chapters for series content', () => {
    const versions = loadVersions();
    const series = versions.find((version) => version.lengthType === 'series');
    expect(series).toBeTruthy();
    if (!series) return;

    const chapters = parseChapters(series.markdown);
    expect(chapters.length).toBeGreaterThan(1);
    expect(chapters[0].title).toBeTruthy();
    expect(chapters[0].estimatedReadTime).toBeTypeOf('number');
  });

  it('handles pipeline_version field when present', () => {
    const versions = loadVersions();
    const withPipeline = versions.filter((version) => version.pipelineVersion !== undefined);
    expect(withPipeline.every((version) => typeof version.pipelineVersion === 'string')).toBe(true);
  });

  it('normalizes updated_at values for sorting', () => {
    const versions = loadVersions();
    expect(
      versions.every(
        (version) => typeof version.updatedAt === 'string' && Number.isFinite(version.updatedAtMs)
      )
    ).toBe(true);
  });
});
