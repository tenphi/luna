/**
 * OpenAI provider container config.
 *
 * Passes the OpenAI-compatible endpoint config from `.env` into the container
 * so the in-container `openai` provider knows where to call. For local-first
 * setups the key is optional — a llama.cpp / LM Studio / vLLM server on
 * localhost typically needs no auth.
 *
 * Registered only when the user has chosen the OpenAI endpoint during setup
 * (setup appends `import './openai.js'` to providers/index.ts at that point).
 *
 * If a key is present in the OneCLI vault instead of `.env`, the gateway
 * injects the Authorization header on the wire; in that case set
 * OPENAI_API_KEY=placeholder so the SDK still sends a bearer for OneCLI to
 * overwrite.
 *
 * A provider with `auth: "chatgpt"` points the container at the host's ChatGPT proxy instead.
 */
import { resolveOpenAiProviderConfig } from '../config/loader.js';
import { containerReachableUrl } from '../container-runtime.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('openai', ({ sessionApi }) => {
  const openai = resolveOpenAiProviderConfig();
  const env: Record<string, string> = {};
  if (openai.auth === 'chatgpt') {
    // The ChatGPT login stays on the host. The container sees an ordinary Responses endpoint that
    // its session token unlocks (./chatgpt.ts).
    env.OPENAI_BASE_URL = `${sessionApi.url}/chatgpt`;
    env.OPENAI_API = 'responses';
    env.OPENAI_API_KEY = sessionApi.token;
  } else {
    if (openai.baseUrl) env.OPENAI_BASE_URL = containerReachableUrl(openai.baseUrl);
    if (openai.api) env.OPENAI_API = openai.api;
    if (openai.apiKey) env.OPENAI_API_KEY = openai.apiKey;
  }
  if (openai.model) env.OPENAI_MODEL = openai.model;
  if (openai.extraBody && Object.keys(openai.extraBody).length > 0) {
    env.OPENAI_EXTRA_BODY = JSON.stringify(openai.extraBody);
  }
  return { env };
});
