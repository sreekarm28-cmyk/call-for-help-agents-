import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const fields = ['visit_fee', 'visit_date', 'visit_time', 'enough_info'] as const;
export type Field = typeof fields[number];
export const answerSchema = z.strictObject({
  visit_fee: z.number().finite().nonnegative().max(9_999_999_999.99).nullable(),
  visit_date: z.iso.date().nullable(),
  visit_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable(),
  enough_info: z.enum(['yes', 'no']),
});
export type Answers = z.infer<typeof answerSchema>;
export type EvaluationCase = {
  id: string; transcript: string; calledAt: string; timezone: 'Asia/Kolkata'; expected: Answers;
  excludedFields: Field[]; reviewNote: string | null; language: string | null;
};
export class DatasetError extends Error {}
const root = fileURLToPath(new URL('../../', import.meta.url));
const inputSchema = z.object({
  id: z.string().trim().min(1).max(100),
  transcript: z.string().trim().min(1).max(60_000),
  calledAt: z.iso.datetime({ offset: true }),
  timezone: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
  language: z.string().max(40).optional(),
});

function records(value: unknown, kind: string): Record<string, unknown>[] {
  const candidate = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { cases?: unknown }).cases : value;
  if (!Array.isArray(candidate) || !candidate.length || candidate.length > 100
      || candidate.some(row => typeof row !== 'object' || !row || Array.isArray(row))) {
    throw new DatasetError(`${kind} must contain 1–100 records, as a JSON array, a cases array, or JSONL.`);
  }
  return candidate as Record<string, unknown>[];
}

export function parseFile(text: unknown, kind: string) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8_000_000) throw new DatasetError(`Choose a valid ${kind} file (up to 8 MB).`);
  const clean = text.replace(/^\uFEFF/, '').trim();
  try {
    const value = JSON.parse(clean);
    // A single JSON object is also a valid one-record JSONL file.
    return records(value && !Array.isArray(value) && typeof value.id === 'string' ? [value] : value, kind);
  } catch (error) {
    if (error instanceof DatasetError) throw error;
    try { return records(clean.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)), kind); }
    catch { throw new DatasetError(`Could not read ${kind}. Use JSON or one JSON object per JSONL line.`); }
  }
}

export function validateDataset(inputs: unknown, labels: unknown): EvaluationCase[] {
  const sourceRows = records(inputs, 'Conversations');
  const labelRows = records(labels, 'Expected labels');
  const seen = new Set<string>();
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of labelRows) {
    if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > 100) throw new DatasetError('Each label needs a string id.');
    const id = row.id.trim();
    if (byId.has(id)) throw new DatasetError(`Duplicate label ID: ${id}`);
    byId.set(id, row);
  }
  const result = sourceRows.map(row => {
    const parsed = inputSchema.safeParse(row);
    if (!parsed.success) throw new DatasetError(`Invalid conversation ${String(row.id ?? '(no ID)')}. Include a transcript, unique id, ISO call timestamp with timezone offset, and Asia/Kolkata timezone.`);
    const input = parsed.data;
    if (seen.has(input.id)) throw new DatasetError(`Duplicate conversation ID: ${input.id}`);
    seen.add(input.id);
    const label = byId.get(input.id);
    if (!label) throw new DatasetError(`Missing expected answers for ${input.id}.`);
    // Only the four scored fields are selected; summary and other stored fields are not evaluated.
    const raw = label.expected as Record<string, unknown> | undefined;
    const answer = answerSchema.safeParse(raw && Object.fromEntries(fields.map(field => [field, raw[field]])));
    if (!answer.success) throw new DatasetError(`Invalid answers for ${input.id}. Supply all four fields; unknown fee/date/time must be null, and enough_info must be yes or no.`);
    const hash = createHash('sha256').update(row.transcript as string).digest('hex');
    const normalizedHash = createHash('sha256').update((row.transcript as string).replace(/\r\n/g, '\n')).digest('hex');
    if (label.transcriptSha256 && label.transcriptSha256 !== hash && label.transcriptSha256 !== normalizedHash) throw new DatasetError(`Transcript differs from the labeled version: ${input.id}. Review the answer key first.`);
    const audit = label.audit_review as { exclude_from_strict_scoring?: unknown; reason?: unknown } | undefined;
    if (audit?.exclude_from_strict_scoring !== undefined && !Array.isArray(audit.exclude_from_strict_scoring)) throw new DatasetError(`Invalid excluded fields for ${input.id}.`);
    // An explicit per-field review list can exclude only those fields. Legacy review flags exclude all four.
    const excludedFields: Field[] = Array.isArray(audit?.exclude_from_strict_scoring)
      ? fields.filter(field => (audit!.exclude_from_strict_scoring as unknown[]).includes(field))
      : label.needs_adjudication === true ? [...fields] : [];
    if (label.needs_adjudication !== undefined && typeof label.needs_adjudication !== 'boolean') throw new DatasetError(`Invalid review flag for ${input.id}.`);
    return { id: input.id, transcript: row.transcript as string, calledAt: input.calledAt, timezone: input.timezone,
      language: input.language ?? null, expected: answer.data, excludedFields,
      reviewNote: excludedFields.length ? (typeof audit?.reason === 'string' ? audit.reason : 'Reference labels need human review.') : null };
  });
  for (const id of byId.keys()) if (!seen.has(id)) throw new DatasetError(`Label ${id} has no matching conversation.`);
  if (!result.some(row => row.excludedFields.length < fields.length)) throw new DatasetError('All reference fields need review; no fields are currently scorable.');
  return result;
}

export const savedDatasets = [
  { id: 'synthetic', name: '38 labeled synthetic conversations' },
  { id: 'latest', name: 'Latest 18 labeled synthetic conversations' },
  { id: 'real', name: '10 saved real calls (private local files)' },
] as const;

export async function loadSavedDataset(id: string) {
  if (id === 'real') {
    try {
      const manifest = JSON.parse(await readFile(root + 'output/evaluation/real-transcripts/manifest.json', 'utf8'));
      const labels = JSON.parse(await readFile(root + 'output/evaluation/real-transcripts/expected-labels.json', 'utf8'));
      return validateDataset(manifest.cases.map((c: { callAttemptId: string; transcript: string; calledAt: string }) => ({
        id: 'real-call-' + c.callAttemptId, transcript: c.transcript, calledAt: c.calledAt, timezone: 'Asia/Kolkata',
      })), labels);
    } catch (error) { if (error instanceof DatasetError) throw error; throw new DatasetError('The private real-call export is not available on this laptop.'); }
  }
  if (id !== 'synthetic' && id !== 'latest') throw new DatasetError('Unknown saved dataset.');
  const versions = id === 'synthetic' ? [2, 4] : [4];
  const result: EvaluationCase[] = [];
  for (const version of versions) {
    const dir = `${root}evaluation/transcript-inputs-v${version}/`;
    const manifest = JSON.parse(await readFile(dir + 'manifest.json', 'utf8'));
    const labels = JSON.parse(await readFile(dir + 'expected-labels.json', 'utf8'));
    const inputs = [];
    for (const entry of manifest.cases) {
      // File names come only from repository manifests, never from upload paths.
      if (!/^synthetic\/[a-z0-9-]+\.txt$/.test(entry.transcriptFile)) throw new DatasetError('Invalid saved transcript path.');
      inputs.push({ id: entry.id, transcript: await readFile(dir + entry.transcriptFile, 'utf8'), calledAt: entry.calledAt,
        timezone: entry.timezone, language: entry.language });
    }
    result.push(...validateDataset(inputs, labels));
  }
  return result;
}

export async function datasetFromRequest(body: unknown) {
  const data = body as { mode?: string; datasetId?: string; inputsText?: unknown; labelsText?: unknown; input?: unknown; label?: unknown } | null;
  if (data?.mode === 'saved' && typeof data.datasetId === 'string') return loadSavedDataset(data.datasetId);
  if (data?.mode === 'upload') return validateDataset(parseFile(data.inputsText, 'conversations'), parseFile(data.labelsText, 'expected labels'));
  if (data?.mode === 'manual') return validateDataset([data.input], [data.label]);
  throw new DatasetError('Choose manual input or a saved/uploaded dataset.');
}
