import { getActiveSpanId, propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import './instrumentation';

const isLangfuseConfigured = Boolean(
  process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY,
);

export async function observe<T>(
  name: string,
  input: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<T> {
  if (!isLangfuseConfigured) {
    return work();
  }

  const outcome = await propagateAttributes(
    { traceName: getActiveSpanId() ? undefined : name },
    () => startActiveObservation(name, async (observation) => {
      observation.update({ input });
      try {
        const result = await work();
        observation.update({ output: { status: 'completed' } });
        return { ok: true, result } as const;
      } catch (error) {
        observation.update({
          level: 'ERROR',
          statusMessage: name + '.failed',
          output: {
            status: 'failed',
            errorCode: name + '.failed',
          },
        });
        return { ok: false, error } as const;
      }
    }),
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}
