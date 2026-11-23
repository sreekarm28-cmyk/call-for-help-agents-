type Confirmation = {
  status?: string; decision?: string | null; extractionStatus?: string | null;
  attemptCount?: number; attemptLimit?: number;
};

export function confirmationLabel(status: string, call?: Confirmation | null) {
  if (status === 'confirmed') return 'Confirmed';
  if (call?.extractionStatus === 'pending') return 'Reviewing confirmation call';
  if (call?.status === 'queued') return 'Confirmation call queued';
  if (call?.status === 'calling') return 'Calling selected provider';
  if (call?.decision === 'needs_clarification') return 'Answer was not clear';
  if (call?.status === 'failed' || call?.extractionStatus === 'failed') {
    return call.attemptLimit && (call.attemptCount ?? 0) >= call.attemptLimit
      ? 'Could not confirm — attempt limit reached' : 'Could not confirm — action needed';
  }
  if (call?.status === 'rejected') return 'Call rejected — waiting for next step';
  return 'Awaiting provider confirmation';
}
