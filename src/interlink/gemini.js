/** Google Gemini provider over plain HTTP (app/ai/providers.py: GeminiProvider). */

import { AIProviderError, HTTPProvider, parseJsonObject } from './provider.js';

export class GeminiProvider extends HTTPProvider {
  static providerName = 'gemini';
  static DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
  static DEFAULT_MODEL = 'gemini-2.5-flash';

  async generateJson({ system, prompt }) {
    const data = await this.post(`${this.baseUrl}/models/${this.model}:generateContent`, {
      headers: { 'x-goog-api-key': this.apiKey },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: this.temperature,
          responseMimeType: 'application/json',
        },
      },
    });
    let text;
    try {
      const parts = data.candidates[0].content.parts;
      if (!Array.isArray(parts)) throw new TypeError('parts');
      text = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
    } catch {
      throw new AIProviderError('Unexpected Gemini response shape');
    }
    return parseJsonObject(text);
  }
}
