// Ollama client shared by the extension's service worker and the bench script.

export const DEFAULT_URL = 'http://localhost:11434';

export const SYSTEM_PROMPT =
  'You correct grammar, spelling and punctuation in English text. ' +
  'Reply with the corrected text only, with no quotes, labels or explanation. ' +
  'Keep the original meaning, wording and style; change only what is wrong. ' +
  'If the text is already correct, reply with it unchanged.';

const rewrite = (goal) =>
  `You rewrite English text. ${goal} Keep the original meaning, names, numbers and facts, and fix any grammar ` +
  'or spelling mistakes. Reply with the rewritten text only, with no quotes, labels or explanation.';

export const REWRITE_PROMPTS = {
  clearer: rewrite('Make it clearer and easier to read.'),
  shorter: rewrite('Make it shorter by removing words that add nothing.'),
  formal: rewrite('Make the tone more formal and professional.'),
  friendly: rewrite('Make the tone friendlier and more casual.'),
};

// [min, max] reply length as a multiple of the input length. Rewrites may shrink or grow a lot more than fixes.
export const GRAMMAR_BOUNDS = [0.5, 1.5];
export const REWRITE_BOUNDS = [0.2, 2];

export const CORS_HELP =
  'Ollama blocked the extension. Menu-bar app: run launchctl setenv OLLAMA_ORIGINS "chrome-extension://*", ' +
  'then quit and reopen Ollama. Terminal: OLLAMA_ORIGINS="chrome-extension://*" ollama serve';

export class OllamaError extends Error {
  constructor(code, message) { super(message); this.code = code; } // code: CORS | OFFLINE | HTTP
}

// GET when body is undefined, otherwise POST JSON. Returns parsed JSON or throws OllamaError.
async function call(url, path, body, signal) {
  let res;
  try {
    res = await fetch(`${url}${path}`, body === undefined ? { signal } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new OllamaError('OFFLINE', `Cannot reach Ollama at ${url}`);
  }
  if (res.status === 403) throw new OllamaError('CORS', 'Ollama rejected the extension origin (set OLLAMA_ORIGINS)');
  if (!res.ok) throw new OllamaError('HTTP', `Ollama returned ${res.status}: ${await res.text()}`);
  return res.json();
}

// system: null uses the model's built-in prompt (for grammar fine-tunes with their own).
export async function correct(text, { model, url = DEFAULT_URL, signal, system = SYSTEM_PROMPT, bounds = GRAMMAR_BOUNDS } = {}) {
  const data = await call(url, '/api/chat', {
    model,
    stream: false,
    keep_alive: '30m',
    // Cap output at the longest reply cleanReply accepts (~3 chars/token) so a looping model can't run for minutes.
    options: { temperature: 0, num_predict: Math.ceil((text.length * bounds[1]) / 3) + 32 },
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: text },
    ],
  }, signal);
  if (data.done_reason === 'length') return text; // cut off mid-reply: never offer a truncated rewrite
  return cleanReply(data.message?.content ?? '', text, bounds);
}

export async function listModels(url = DEFAULT_URL) {
  return (await call(url, '/api/tags')).models.map((m) => m.name);
}

// Connection test that matches a real check: Chrome sends Origin on POSTs (so Ollama's 403
// shows up here) but not on the GET listModels uses. Throws OllamaError; HTTP 404 = model missing.
export async function checkAccess(model, url = DEFAULT_URL) {
  await call(url, '/api/show', { model });
}

// Model output is untrusted: strip wrappers small models add, reject replies that aren't a correction.
export function cleanReply(reply, original, [min, max] = GRAMMAR_BOUNDS) {
  let out = reply.trim().replace(/^(corrected|correction|fixed|rewritten|rewrite)(\s+(text|sentence|version))?\s*:\s*/i, '');
  const quoted = /^["“'].*["”']$/s;
  if (quoted.test(out) && !quoted.test(original.trim())) out = out.slice(1, -1).trim();
  if (/Reply with the (corrected|rewritten) text only/.test(out)) return original; // model echoed the prompt
  // A reply far longer or shorter than the input is the model rambling or truncating.
  if (out.length > original.length * max + 10 || out.length < original.length * min) return original;
  return out;
}
