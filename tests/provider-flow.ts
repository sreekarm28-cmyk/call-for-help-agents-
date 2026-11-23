import { withFlow } from './flow-helpers.js';
import { testAuthFlow } from './auth-flow.js';
import { testRequestFlow } from './request-flow.js';
import { testProviderSearchFlow } from './provider-search-flow.js';
import { testBookingFlow } from './booking-flow.js';
import { testReplacementFlow } from './replacement-flow.js';
import { testBookingVisibilityFlow } from './booking-visibility-flow.js';
import { testLlmExtractionFlow } from './llm-extraction-flow.js';
import { testCallLimitFlow } from './call-limit-flow.js';
import { testConfirmationFlow } from './confirmation-flow.js';
import { testProviderRecallFlow } from './provider-recall-flow.js';
import { testProviderPreferencesFlow } from './provider-preferences-flow.js';

const flows = {
  auth: [testAuthFlow],
  request: [testRequestFlow],
  'provider-search': [testRequestFlow, testProviderSearchFlow],
  booking: [testRequestFlow, testProviderSearchFlow, testBookingFlow],
  replacement: [testRequestFlow, testProviderSearchFlow, testBookingFlow, testReplacementFlow],
  'booking-visibility': [testRequestFlow, testProviderSearchFlow, testBookingFlow, testReplacementFlow, testBookingVisibilityFlow],
  'llm-extraction': [testRequestFlow, testProviderSearchFlow, testLlmExtractionFlow],
  'call-limit': [testCallLimitFlow],
  confirmation: [testConfirmationFlow],
  'provider-recall': [testProviderRecallFlow],
  'provider-preferences': [testProviderPreferencesFlow],
  all: [testAuthFlow, testRequestFlow, testProviderSearchFlow, testBookingFlow, testReplacementFlow, testBookingVisibilityFlow, testLlmExtractionFlow, testCallLimitFlow, testConfirmationFlow, testProviderRecallFlow, testProviderPreferencesFlow],
};
const selected = process.argv[2] ?? 'all';
if (!(selected in flows)) throw new Error('Unknown flow. Choose ' + Object.keys(flows).join(', '));
await withFlow(async (context) => {
  for (const test of flows[selected as keyof typeof flows]) await test(context);
});
console.log('PASS ' + selected + ' flow tests');
