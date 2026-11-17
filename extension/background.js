import { correct, OllamaError, CORS_HELP, REWRITE_PROMPTS, REWRITE_BOUNDS } from './lib/ollama.js';
import { checkText } from './lib/check.js';
import { applyEdits } from './lib/diff.js';
import { getSettings } from './lib/settings.js';

const CACHE_MAX = 500;
// shortcut: rewrites send the whole selection in one call; past this, Ollama's context window may truncate it.
const REWRITE_MAX_CHARS = 3000;
const cache = new Map(); // `${model}\n${style}\n${text}` -> model reply (style is '' for grammar)
let inflight = null; // AbortController of the current check; a new check cancels it

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'check-selection', title: 'Check grammar', contexts: ['selection'] });
  // Ollama 403s any Origin not in OLLAMA_ORIGINS, so drop Origin from our own requests to localhost.
  // initiatorDomains keeps web pages' requests to Ollama untouched (they stay blocked).
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
      condition: { requestDomains: ['localhost', '127.0.0.1'], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] },
    }],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'check-selection') triggerCheck(tab, info.frameId);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'check-selection') triggerCheck(tab);
});

// Without frameId the message goes to every frame; only the frame holding the selection acts.
// Tabs opened before the extension was installed have no content script, so inject it and retry
// (activeTab grants access because the user just pressed the shortcut or used the menu).
async function triggerCheck(tab, frameId) {
  const opts = frameId === undefined ? {} : { frameId };
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'check-selection' }, opts);
  } catch {
    try {
      const target = frameId === undefined ? { tabId: tab.id, allFrames: true } : { tabId: tab.id, frameIds: [frameId] };
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'check-selection' }, opts);
    } catch {
      // Pages extensions can't touch (chrome://, the Web Store): nothing to do.
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'check') return;
  check(msg.text, msg.style).then(sendResponse, (err) => sendResponse({ error: describe(err) }));
  return true; // async response
});

// style: undefined for a grammar check, or a REWRITE_PROMPTS key.
async function check(text, style) {
  if (style !== undefined && !Object.hasOwn(REWRITE_PROMPTS, style)) throw new Error(`Unknown rewrite style: ${style}`);
  if (style && text.length > REWRITE_MAX_CHARS) {
    return { error: `Select at most ${REWRITE_MAX_CHARS} characters to rewrite (you selected ${text.length}).` };
  }
  inflight?.abort();
  const ctrl = (inflight = new AbortController());
  const { model, url } = await getSettings();
  const cached = async (input, opts) => {
    const key = `${model}\n${style ?? ''}\n${input}`;
    if (cache.has(key)) return cache.get(key);
    const fixed = await correct(input, { model, url, signal: ctrl.signal, ...opts });
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, fixed);
    return fixed;
  };
  // Rewrites can merge or split sentences, so the whole selection goes in one call and is not diffed.
  if (style) {
    // The model's reply is trimmed; keep the selection's surrounding whitespace (e.g. a trailing newline) on Replace.
    const [, lead, core, trail] = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!core) return { corrected: text };
    return { corrected: lead + (await cached(core, { system: REWRITE_PROMPTS[style], bounds: REWRITE_BOUNDS })) + trail };
  }
  const edits = await checkText(text, (sentence) => cached(sentence));
  return { edits, corrected: applyEdits(text, edits) };
}

function describe(err) {
  if (err.name === 'AbortError') return 'Cancelled by a newer check.';
  if (!(err instanceof OllamaError)) return `Unexpected error: ${err.message}`;
  if (err.code === 'CORS') return CORS_HELP;
  if (err.code === 'OFFLINE') return 'Ollama is not running. Start the Ollama app and try again.';
  if (/not found/i.test(err.message)) return 'Model not installed. Pick another in the GrammerPlus popup, or run: ollama pull <model>.';
  return err.message;
}
