import { describe, expect, it } from 'vitest';
import { getProviderForModel, PROVIDERS } from '../scripts/lib/model-provider.mjs';

describe('model provider selection', () => {
  it('routes gpt-* to OpenAI', () => {
    expect(getProviderForModel('gpt-5.1')).toBe(PROVIDERS.OPENAI);
  });

  it('routes gemini-* to Google GenAI', () => {
    expect(getProviderForModel('gemini-3-pro-preview')).toBe(PROVIDERS.GOOGLE_GENAI);
    expect(getProviderForModel('GEMINI-3-PRO-PREVIEW')).toBe(PROVIDERS.GOOGLE_GENAI);
  });
});

