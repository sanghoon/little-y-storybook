import { describe, expect, it } from 'vitest';
import { loadVersions, parseChapters } from '../src/lib/content';

describe('content loader', () => {
  it('loads versions from markdown files', () => {
    const versions = loadVersions();
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0].title).toBeTruthy();
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

  it('allows missing pipeline_version in legacy content', () => {
    const versions = loadVersions();
    expect(versions.some((version) => version.pipelineVersion === undefined)).toBe(true);
    const withPipeline = versions.find((version) => version.pipelineVersion);
    if (withPipeline) {
      expect(withPipeline.pipelineVersion).toBeTypeOf('string');
    }
  });
});
