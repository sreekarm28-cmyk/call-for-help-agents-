import { createHash } from 'node:crypto';
import { z } from 'zod';
import { generateStructured, geminiModel } from '../gemini.js';
import { transcriptExtractionRules, transcriptWithCallDate } from '../transcript-extraction.js';
import { answerSchema, type EvaluationCase, type Answers } from './dataset.js';
import type { EvaluationRun } from './store.js';

export const evaluationPromptVersion = 'transcript-fields-v5-reference-date-policy-4';
// Reuse the backend extraction rules and Gemini client, but omit summary generation and judge calls.
export const evaluationPrompt = transcriptExtractionRules
  .split('\n').filter(line => !line.startsWith('- summary:')).join('\n') + `

Evaluation-only output: extract visit_fee, visit_date, visit_time, enough_info,
and availability_as_said. availability_as_said is an unscored display field:
preserve the provider's timing words including broad periods or uncertainty.
Do not generate a summary or a repair-price field. Other fee rules above help distinguish costs.
Decide enough_info from THREE independent details in the transcript:
1. A clear visit day; resolve confirmed relative days using the reference call date.
2. A useful arrival time or period: exact time, a window, morning, afternoon,
   evening, night, or after lunch. A broad period counts even if visit_time is null.
3. A clear applicable visit/inspection fee OR total-job quote, including an explicit
   free inspection (visit_fee 0). Preserve visit_fee as null for a combined total only.
When the provider is willing to visit, return "yes" if AT LEAST TWO of these
three details are supported: day + time/period, day + fee, OR time/period + fee.
All three are NOT required. One detail alone is "no".
Keep missing exact fields null; do not invent an exact hour for a broad period.
Do not count tentative, withdrawn, contradicted or unaccepted details, a callback
time, a customer budget, an arithmetic example, or an agent's unaccepted proposal.
An inspection fee credited or waived when work is done counts if the condition is clear.
Return "no" for a refusal or unclear willingness, regardless of the detail count.
Before returning, re-read the transcript ONLY for fields still missing/unknown.
Fill only those missing fields when clearly supported; keep already supported
values unchanged. Do not guess, use outside information, or make another API call.
Then apply the two-of-three rule using all supported details, including broad periods.
Enough information is for customer review, NOT confirmation or permission to call.
Return exactly these keys: {"visit_fee":null,"visit_date":null,"visit_time":null,"enough_info":"no","availability_as_said":null}.`;

const evaluationOutputSchema = answerSchema.extend({availability_as_said:z.string().trim().min(1).max(500).nullable()});

export const modelConfiguration = {
  model: geminiModel, promptVersion: evaluationPromptVersion,
  promptSha256: createHash('sha256').update(evaluationPrompt).digest('hex'),
  policyVersion: 4,
  outputVersion: 2,
  referenceDateProvided: true,
  scope: 'Four scored fields plus unscored availability wording; shares production extraction rules and Gemini client. Summary is neither generated nor scored.',
};
export type ModelContext = {prompt:string;captureAvailability:boolean};
export type EvaluateCase = (entry: EvaluationCase, context?: ModelContext) => Promise<{actual: Answers; usage: Record<string, number>; availabilityAsSaid?:string|null}>;
export async function contextForRun(run: EvaluationRun): Promise<ModelContext> {
  if (run.configuration.referenceDateProvided !== true) {
    throw new Error('This saved run used different reference call-date context. Start a new evaluation; old and new scores must not be mixed.');
  }
  const prompt = run.promptSnapshot ?? evaluationPrompt;
  if (createHash('sha256').update(prompt).digest('hex') !== run.configuration.promptSha256 || run.configuration.model !== geminiModel) {
    throw new Error('This saved run uses an unavailable model or prompt. Start a new run to test the current prompt without mixing versions.');
  }
  return {prompt,captureAvailability:(run.configuration.outputVersion??1)>=2};
}
export const evaluateCase: EvaluateCase = async (entry, context={prompt:evaluationPrompt,captureAvailability:true}) => {
  let usage: Record<string,number> = {};
  // Expected answers, review flags and rationales must never be part of this request.
  const output = await generateStructured(context.prompt,
    transcriptWithCallDate(entry.transcript, entry.calledAt),
    context.captureAvailability ? evaluationOutputSchema : answerSchema,
    'Evaluate transcript field extraction', {onUsage: value => { usage = value; }});
  const {availability_as_said,...actual} = output as Answers & {availability_as_said?:string|null};
  return {actual,usage,availabilityAsSaid:availability_as_said??null};
};
