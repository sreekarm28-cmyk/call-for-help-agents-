import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { z } from 'zod';
import { getActiveSpanId, propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import './instrumentation.js';

export const geminiModel = 'gemini-3.5-flash-lite';
export class TemporaryGeminiError extends Error {
  constructor(message: string, readonly retryAfterMs: number | null = null) { super(message); }
}
export class GeminiRateLimitError extends TemporaryGeminiError {
  constructor(retryAfterMs: number | null, readonly dailyQuota: boolean) {
    super('Gemini returned HTTP 429', retryAfterMs);
  }
}

function retryAfterHeader(response: Response): number | null {
  const header=response.headers.get('retry-after');if(!header)return null;
  const seconds=Number(header),delay=Number.isFinite(seconds)?seconds*1000:Date.parse(header)-Date.now();
  return Number.isFinite(delay)?Math.max(0,delay):null;
}

export async function readGeminiRateLimit(response: Response) {
  let retryAfterMs = retryAfterHeader(response);
  let dailyQuota = false;
  try {
    const body = await response.json() as {error?:{details?:Array<{'@type'?:string;retryDelay?:string;violations?:Array<{quotaId?:string;quotaMetric?:string}>}>}};
    for (const detail of body.error?.details ?? []) {
      if (detail['@type']?.endsWith('RetryInfo') && typeof detail.retryDelay === 'string') {
        const match = /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay);
        if (match) retryAfterMs = Math.max(retryAfterMs ?? 0, Number(match[1]) * 1000);
      }
      if (detail.violations?.some(v => /perday|per_day|daily/i.test((v.quotaId??'')+' '+(v.quotaMetric??'')))) dailyQuota = true;
    }
  } catch { /* A provider can return an empty/non-JSON error; retain the HTTP status and header. */ }
  return new GeminiRateLimitError(retryAfterMs, dailyQuota);
}

export async function generateStructured<T extends z.ZodType>(
  prompt: string, input: string, schema: T, name = 'Generate structured response',
  options?: { onUsage?: (usage: Record<string, number>) => void },
): Promise<z.infer<T>> {
  return propagateAttributes({ traceName: getActiveSpanId() ? undefined : name }, () => startActiveObservation(name, async (generation) => {
    generation.update({ model: geminiModel });
    try {
      const result = await requestStructured(prompt, input, schema, (usage) => {
        generation.update({ usageDetails: usage });
        options?.onUsage?.(usage);
      });
      generation.update({ output: { status: 'completed' } });
      return result;
    } catch (error) {
      generation.update({ level: 'ERROR', statusMessage: 'Gemini request or response validation failed.' });
      throw error;
    }
  }, { asType: 'generation' }));
}

async function requestStructured<T extends z.ZodType>(
  prompt: string, input: string, schema: T, recordUsage: (usage: Record<string, number>) => void,
): Promise<z.infer<T>> {
  const localConfig = process.env.GOOGLE_API_KEY?.trim() ? null
    : await readFile(new URL('../LiveKit-Vobiz-Outbound/.env.local', import.meta.url)).catch(() => null);
  const apiKey = process.env.GOOGLE_API_KEY?.trim() || (localConfig && parse(localConfig).GOOGLE_API_KEY?.trim());
  if (!apiKey) throw new Error('Gemini API key is missing.');

  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt }] },
        contents: [{ role: 'user', parts: [{ text: input }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: z.toJSONSchema(schema, { io: 'input' }) },
      }),
    });
  } catch {
    throw new TemporaryGeminiError('Gemini connection failed or timed out.');
  }
  if (response.status === 429) throw await readGeminiRateLimit(response);
  if (response.status >= 500) {
    const delay=retryAfterHeader(response);await response.body?.cancel();
    throw new TemporaryGeminiError(`Gemini returned HTTP ${response.status}`,delay);
  }
  if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}`);
  const body = await response.json() as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    usageMetadata?: {
      promptTokenCount?: number; candidatesTokenCount?: number;
      thoughtsTokenCount?: number; totalTokenCount?: number;
    };
  };
  if (body.usageMetadata) {
    const reported = body.usageMetadata;
    const usage: Record<string, number> = {};
    if (reported.promptTokenCount !== undefined) usage.input = reported.promptTokenCount;
    // Gemini reports reasoning separately from visible output; include it in output usage.
    if (reported.candidatesTokenCount !== undefined || reported.thoughtsTokenCount !== undefined) {
      usage.output = (reported.candidatesTokenCount ?? 0) + (reported.thoughtsTokenCount ?? 0);
    }
    if (reported.totalTokenCount !== undefined) usage.total = reported.totalTokenCount;
    recordUsage(usage);
  }
  const output = (body.candidates?.[0]?.content?.parts ?? []).filter((part) => !part.thought)
    .map((part) => part.text ?? '').join('');
  return schema.parse(JSON.parse(output));
}
