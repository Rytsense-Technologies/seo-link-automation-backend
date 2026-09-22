/** Groq via its OpenAI-compatible endpoint (app/ai/providers.py: GroqProvider). */

import { OpenAICompatibleProvider } from './openai.js';

export class GroqProvider extends OpenAICompatibleProvider {
  static providerName = 'groq';
  static DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
  static DEFAULT_MODEL = 'llama-3.3-70b-versatile';
}
