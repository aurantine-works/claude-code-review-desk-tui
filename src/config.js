// User configuration (<RD_HOME>/config.json merged over the defaults).
//
// No lodash here: loadConfig() runs in the post-tool-use hook (every Write/Edit), where lodash alone
// would cost ~30 ms of start-up.
import { paths } from './store/paths.js';
import { readJson } from './store/io.js';

export const DEFAULT_CONFIG = {
  docs: {
    include: ['**/docs/**/*.md', '**/reports/**/*.md', '**/*.report.md', '**/*-plan.md', '**/*.design.md'],
    exclude: ['**/node_modules/**', '**/.git/**', '**/README.md', '**/CHANGELOG.md'],
    autoOpen: false,
  },
  review: { sendMode: 'instant', idleEndMinutes: null },
  // autoInject: type `/review-reply <id>` into the session's tmux pane / ccd session when it is idle.
  // injectIdleSeconds: how long the session must have been idle first; injectWaitSeconds: how long deliver() waits for that.
  // claudeBin: the executable channel C starts for a headless resume (`claude --resume <id> -p /review-reply <id>`) and shows
  // in the interactive resume command; a path or a name on PATH (no arguments, it is run without a shell).
  // autoResume: what the review screen does when feedback is sent to a session that has ended: 'ask' opens the "session ended"
  // dialog (c / h / l), 'headless' starts the background resume (the dialog's [h]) by itself and says so in a notice.
  delivery: { autoInject: true, injectIdleSeconds: 2, injectWaitSeconds: 30, claudeBin: 'claude', autoResume: 'ask' },
  anchor: { threshold: 0.5 },
  // ui.markdown: how Markdown bodies are shown at first, 'rendered' (half-rendered) or 'source'; M toggles it in the review.
  // ui.lang: language of the UI texts ('en', or the name of an installed language pack in src/i18n); the RD_LANG environment variable overrides it.
  ui: { mouse: true, markdown: 'rendered', lang: 'en' },
  // notify.bell: ring claude's terminal when a plan review starts waiting (plan-review hook).
  notify: { bell: true },
  editor: null,
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge of plain objects; anything else (arrays included) from `over` replaces the base value. */
function merge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (key === '__proto__') continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : structuredClone(value);
  }
  return out;
}

export const AUTO_RESUME_VALUES = ['ask', 'headless'];

/**
 * Check the merged configuration. A value that is not allowed falls back to the default (a typo must not change what rd does);
 * `problems` lists what was replaced, for `rd doctor`.
 * @returns {{config: object, problems: string[]}}
 */
export function validateConfig(config) {
  const problems = [];
  const out = structuredClone(config);
  const resume = out.delivery?.autoResume;
  if (!AUTO_RESUME_VALUES.includes(resume)) {
    problems.push(`delivery.autoResume is ${JSON.stringify(resume)}; it must be "ask" or "headless" ("${DEFAULT_CONFIG.delivery.autoResume}" is used)`);
    out.delivery = { ...out.delivery, autoResume: DEFAULT_CONFIG.delivery.autoResume };
  }
  return { config: out, problems };
}

/** The defaults merged with config.json, validated; `problems` says which values were not usable. */
export function loadConfigChecked() {
  let user = {};
  try {
    user = readJson(paths.config(), {});
  } catch {
    /* corrupt user config: fall back to defaults */
  }
  return validateConfig(merge(structuredClone(DEFAULT_CONFIG), isPlainObject(user) ? user : {}));
}

export const loadConfig = () => loadConfigChecked().config;
