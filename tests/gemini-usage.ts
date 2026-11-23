import assert from 'node:assert/strict';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { z } from 'zod';

process.env.LANGFUSE_PUBLIC_KEY = '';
process.env.LANGFUSE_SECRET_KEY = '';
process.env.GOOGLE_API_KEY = 'test-key';
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
const { generateStructured, geminiModel } = await import('../server/gemini.js');
const originalFetch = globalThis.fetch;
const schema = z.object({ ok: z.boolean() });
let usageMetadata: Record<string, number> | undefined = {
  promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125,
};
let output = '{"ok":true}';
globalThis.fetch = async () => Response.json({
  candidates: [{ content: { parts: [{ text: output }] } }], usageMetadata,
});

try {
  assert.deepEqual(await generateStructured('Test prompt', 'Test input', schema, 'Extract call fees and visit time'), { ok: true });
  await provider.forceFlush();
  let span = exporter.getFinishedSpans().at(-1)!;
  assert.equal(span.name, 'Extract call fees and visit time');
  assert.equal(span.attributes['langfuse.observation.type'], 'generation');
  assert.equal(span.attributes['langfuse.observation.model.name'], geminiModel);
  const usage = () => JSON.parse(String(exporter.getFinishedSpans().at(-1)!.attributes['langfuse.observation.usage_details']));
  assert.deepEqual(usage(), { input: 100, output: 25, total: 125 });
  console.log('PASS records model, input, output including reasoning, and total tokens.');

  usageMetadata = { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };
  await generateStructured('Test prompt', 'Test input', schema);
  assert.deepEqual(usage(), { input: 0, output: 0, total: 0 });
  usageMetadata = undefined;
  await generateStructured('Test prompt', 'Test input', schema);
  assert.equal(exporter.getFinishedSpans().at(-1)!.attributes['langfuse.observation.usage_details'], undefined);
  console.log('PASS preserves reported zeros and leaves absent usage unknown.');

  usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 };
  output = 'invalid JSON';
  await assert.rejects(generateStructured('Test prompt', 'Test input', schema));
  span = exporter.getFinishedSpans().at(-1)!;
  assert.equal(span.attributes['langfuse.observation.level'], 'ERROR');
  assert.deepEqual(usage(), { input: 100, output: 20, total: 120 });
  console.log('PASS retains consumed tokens when model output validation fails.');
} finally {
  globalThis.fetch = originalFetch;
  await provider.shutdown();
}
