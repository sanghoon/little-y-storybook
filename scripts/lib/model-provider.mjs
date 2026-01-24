import { ChatOpenAI } from '@langchain/openai';

export const PROVIDERS = /** @type {const} */ ({
  OPENAI: 'openai',
  GOOGLE_GENAI: 'google-genai',
});

export const getProviderForModel = (modelName) => {
  const name = String(modelName ?? '').trim();
  if (/^gemini-/i.test(name)) return PROVIDERS.GOOGLE_GENAI;
  return PROVIDERS.OPENAI;
};

export const createChatModel = async ({
  model,
  temperature,
  reasoningEffort,
}) => {
  const provider = getProviderForModel(model);

  if (provider === PROVIDERS.GOOGLE_GENAI) {
    if (!process.env.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is required to use Gemini models.');
    }
    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    const chat = new ChatGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
      model: String(model),
      ...(temperature === undefined ? {} : { temperature }),
    });
    // Gemini tool/structured-output support varies; prefer our robust JSON-extract path.
    chat._supportsStructuredOutput = false;
    chat._provider = provider;
    return chat;
  }

  const modelKwargs = reasoningEffort
    ? { reasoning_effort: reasoningEffort }
    : undefined;
  const chat = new ChatOpenAI({
    model: String(model),
    ...(modelKwargs ? { modelKwargs } : {}),
    ...(temperature === undefined ? {} : { temperature }),
  });
  chat._supportsStructuredOutput = true;
  chat._provider = provider;
  return chat;
};

