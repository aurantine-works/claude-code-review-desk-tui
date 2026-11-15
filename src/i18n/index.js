// UI text lookup. English is the built-in language; other languages are optional packs (src/i18n/<lang>.js) that are loaded
// when present, so a checkout without a pack simply runs in English.
//
//   t('status.comment')                 a plain string
//   t('cards.moreLines', { n: 3 })      a dict value that is a function (p) => string
//
// The language is resolved on the first t() call (RD_LANG, then config ui.lang, then 'en') and memoized.
// Keep this module cheap: the post-tool-use hook (every Write/Edit) imports it. src/config.js must not import it.
import en from './en.js';
import { loadConfig } from '../config.js';

/** Optional language packs. A pack that is not installed is skipped. */
export const PACKS = ['zh'];

const packs = { en };
for (const lang of PACKS) {
  try {
    packs[lang] = (await import(/* @vite-ignore */ new URL(`./${lang}.js`, import.meta.url).href)).default;
  } catch {
    /* pack not installed */
  }
}

let active = null;

/** True when the pack for `lang` is available ('en' always is). */
export const hasPack = (lang) => Object.hasOwn(packs, lang);

/** The language that was asked for (RD_LANG, then config ui.lang), before the fallback to what is installed. */
export function requestedLang() {
  const env = process.env.RD_LANG;
  if (env) return env;
  try {
    const lang = loadConfig().ui?.lang;
    if (typeof lang === 'string' && lang) return lang;
  } catch {
    /* unreadable config: English */
  }
  return 'en';
}

function resolve() {
  if (active === null) {
    const lang = requestedLang();
    active = hasPack(lang) ? lang : 'en';
  }
  return active;
}

/** The language t() uses. */
export const currentLang = () => resolve();

/** Force a language (tests). An unknown language means English. */
export function setLang(lang) {
  active = hasPack(lang) ? lang : 'en';
}

/** Forget the language so the next t() resolves it again from the environment / config (tests). */
export function resetLang() {
  active = null;
}

function lookup(dict, key) {
  let v = dict;
  for (const part of key.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, part)) return undefined;
    v = v[part];
  }
  return v;
}

/** @param {string} key dotted path into the dictionary  @param {object} [params] passed to function values */
export function t(key, params) {
  let v = lookup(packs[resolve()], key);
  if (v === undefined) v = lookup(en, key);
  if (v === undefined) throw new Error(`i18n: missing key ${key}`);
  return typeof v === 'function' ? v(params ?? {}) : v;
}
