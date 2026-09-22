/** OpenAI chat-completions provider; also the base for Groq's OpenAI-compatible API (app/ai/providers.py). */

import { AIProviderError, HTTPProvider, parseJsonObject } from './provider.js';

export class OpenAICompatibleProvider extends HTTPProvider {
  static providerName = 'openai';
  static DEFAULT_BASE_URL = 'https://api.openai.com/v1';
  static DEFAULT_MODEL = 'gpt-4o-mini';

  async generateJson({ system, prompt }) {
    const data = await this.post(`${this.baseUrl}/chat/completions`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        temperature: this.temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      },
    });
    let text;
    try {
      text = data.choices[0].message.content;
      if (text === undefined) throw new TypeError('content');
    } catch {
      throw new AIProviderError(`Unexpected ${this.name} response shape`);
    }
    return parseJsonObject(text || '');
  }
}
