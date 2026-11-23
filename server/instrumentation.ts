import 'dotenv/config';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';

const isLangfuseConfigured = Boolean(
  process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY,
);

export const langfuseSpanProcessor = isLangfuseConfigured
  ? new LangfuseSpanProcessor({ exportMode: 'immediate' })
  : null;

const langfuseTracerProvider = langfuseSpanProcessor
  ? new NodeTracerProvider({ spanProcessors: [langfuseSpanProcessor] })
  : null;

export async function shutdownTracing() {
  await langfuseTracerProvider?.shutdown();
}

if (langfuseTracerProvider) {
  langfuseTracerProvider.register();
  console.log('Langfuse tracing enabled');
} else {
  console.log('Langfuse tracing disabled until LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY are set');
}
