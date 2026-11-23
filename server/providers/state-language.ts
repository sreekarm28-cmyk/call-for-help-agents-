import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../../config/call-languages.json', import.meta.url), 'utf8')) as {
  languages: Record<string, string>; states: Record<string, string>;
};

export function languageForState(state: string | null) {
  const language = config.states[state?.trim().toLowerCase() ?? ''];
  return typeof language === 'string' ? language : 'en';
}

export function callLanguage(code: string | null) {
  const preferredLanguage = code && typeof config.languages[code] === 'string' ? code : 'en';
  return { preferredLanguage, languageName: config.languages[preferredLanguage] };
}
