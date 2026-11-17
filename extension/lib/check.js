import { splitSentences } from './sentences.js';
import { diffEdits } from './diff.js';

// Checks text sentence by sentence; returns edits with offsets into the full text.
// correctFn(sentence) -> Promise<corrected sentence>
export async function checkText(text, correctFn) {
  const sentences = splitSentences(text);
  const fixed = await Promise.all(sentences.map((s) => correctFn(s.text)));
  return sentences.flatMap((s, k) =>
    diffEdits(s.text, fixed[k]).map((e) => ({ ...e, start: e.start + s.start, end: e.end + s.start })),
  );
}
