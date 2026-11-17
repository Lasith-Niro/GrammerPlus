import { DEFAULT_URL } from './ollama.js';

// TODO(phase 0): set the default model from the bake-off results.
export const DEFAULTS = { model: 'qwen2.5:1.5b', url: DEFAULT_URL, disabledSites: [] };

export const getSettings = async () => ({ ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) });
