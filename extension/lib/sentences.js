// shortcut: Intl.Segmenter splits after abbreviations like "Dr.", upgrade if fragments cause bad fixes.
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

// Returns [{start, text}] with surrounding whitespace trimmed; blank segments dropped.
export function splitSentences(text) {
  const out = [];
  for (const { index, segment } of segmenter.segment(text)) {
    const lead = segment.length - segment.trimStart().length;
    const trimmed = segment.trim();
    if (trimmed) out.push({ start: index + lead, text: trimmed });
  }
  return out;
}
