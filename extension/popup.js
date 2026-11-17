import { listModels, checkAccess, CORS_HELP } from './lib/ollama.js';
import { getSettings } from './lib/settings.js';

const $ = (id) => document.getElementById(id);
const settings = await getSettings();

const [cmd] = await chrome.commands.getAll();
$('shortcut').textContent = cmd?.shortcut || 'no shortcut set (chrome://extensions/shortcuts)';
if (/Mac/.test(navigator.userAgent)) {
  const [s1, s5, enter, copy] = $('card-keys').querySelectorAll('kbd');
  [s1.textContent, s5.textContent, enter.textContent, copy.textContent] = ['⌥1', '⌥5', '⌘↩', '⌥C'];
}

// Per-site toggle; activeTab gives us the URL of the tab the popup was opened on.
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const host = tab?.url?.startsWith('http') ? new URL(tab.url).hostname : null;
if (host) {
  $('host').textContent = host;
  $('site-off').checked = settings.disabledSites.includes(host);
  $('site-off').onchange = async (e) => {
    const { disabledSites } = await getSettings();
    const next = e.target.checked ? [...new Set([...disabledSites, host])] : disabledSites.filter((h) => h !== host);
    await chrome.storage.sync.set({ disabledSites: next });
  };
} else {
  $('site-off').disabled = true;
}

try {
  const models = await listModels(settings.url);
  const names = models.includes(settings.model) ? models : [settings.model, ...models];
  $('model').replaceChildren(...names.map((n) => new Option(n, n, false, n === settings.model)));
  $('model').disabled = false;
  $('model').onchange = (e) => chrome.storage.sync.set({ model: e.target.value });
  if (models.includes(settings.model)) {
    await checkAccess(settings.model, settings.url);
    $('status').textContent = 'Connected to Ollama.';
  } else {
    $('status').textContent = `Model ${settings.model} is not installed. Pick another or run: ollama pull ${settings.model}`;
    $('status').className = 'bad';
  }
} catch (err) {
  $('status').className = 'bad';
  $('status').textContent = err.code === 'CORS' ? CORS_HELP
    : err.code === 'OFFLINE' ? 'Ollama is not running. Start the Ollama app.'
    : err.message;
}
