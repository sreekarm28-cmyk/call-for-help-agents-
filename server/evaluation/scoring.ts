import { fields, type Answers, type EvaluationCase, type Field } from './dataset.js';

export type CaseResult = {
  id: string; status: 'completed' | 'error' | 'excluded'; actual: Answers | null;
  durationMs: number; usage: Record<string, number>; error: string | null;
  availabilityAsSaid?: string | null;
};
export type Metric = { numerator: number; denominator: number; percent: number | null };
const metric = (numerator: number, denominator: number): Metric => ({ numerator, denominator, percent: denominator ? Math.round(numerator / denominator * 1000) / 10 : null });

export function scoreRun(cases: EvaluationCase[], results: CaseResult[], attempts: CaseResult[] = results) {
  const byId = new Map(results.map(result => [result.id, result]));
  const perField = Object.fromEntries(fields.map(field => [field, { correct: 0, scored: 0, excluded: 0 }])) as Record<Field, {correct:number;scored:number;excluded:number}>;
  let completeCorrect = 0, completeScored = 0, invented = 0, unknownSlots = 0, falseYes = 0, expectedNo = 0;
  let excluded = 0, attempted = 0, successful = 0, errors = 0;
  for (const entry of cases) {
    const result = byId.get(entry.id);
    if (!result) continue;
    if (result.status === 'excluded') { excluded++; for (const field of fields) perField[field].excluded++; continue; }
    attempted++;
    if (result.status === 'error') errors++; else successful++;
    const scoredFields = fields.filter(field => !entry.excludedFields.includes(field));
    for (const field of fields) {
      if (entry.excludedFields.includes(field)) { perField[field].excluded++; continue; }
      perField[field].scored++;
      if (result.actual && entry.expected[field] === result.actual[field]) perField[field].correct++;
      if (result.actual && field !== 'enough_info' && entry.expected[field] === null) {
        unknownSlots++;
        if (result.actual[field] !== null) invented++;
      }
    }
    if (scoredFields.length === fields.length) {
      completeScored++;
      if (result.actual && fields.every(field => entry.expected[field] === result.actual![field])) completeCorrect++;
    }
    if (result.actual && scoredFields.includes('enough_info') && entry.expected.enough_info === 'no') {
      expectedNo++; if (result.actual.enough_info === 'yes') falseYes++;
    }
  }
  const fieldResults = Object.fromEntries(fields.map(field => [field, { ...metric(perField[field].correct, perField[field].scored), excluded: perField[field].excluded }])) as Record<Field, Metric & {excluded:number}>;
  return {
    overall: metric(Object.values(perField).reduce((n,v)=>n+v.correct,0), Object.values(perField).reduce((n,v)=>n+v.scored,0)),
    completeCase: metric(completeCorrect, completeScored), inventedValues: metric(invented, unknownSlots),
    enoughInfo: fieldResults.enough_info, falseYes: metric(falseYes, expectedNo), perField: fieldResults,
    totalCases: cases.length, finishedCases: results.length, attemptedCases: attempted, successfulCases: successful,
    modelErrors: errors, fullyExcludedCases: excluded, responseCoverage: metric(successful, attempted),
    usage: attempts.reduce((sum,result)=>{for(const [key,value] of Object.entries(result.usage))sum[key]=(sum[key]??0)+value;return sum;},{} as Record<string,number>),
    durationMs: attempts.reduce((sum,result)=>sum+result.durationMs,0),
    requestAttempts: attempts.filter(attempt=>attempt.status!=='excluded').length,
  };
}
