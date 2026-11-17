// Word-level diff: turns (original, corrected) into edits on the original's offsets.

const TOKEN = /\s+|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;

export const tokenize = (text) => text.match(TOKEN) ?? [];

// Returns [{start, end, replacement}] sorted by start, non-overlapping.
export function diffEdits(original, corrected) {
  const a = tokenize(original);
  const b = tokenize(corrected);

  // LCS table, filled from the end so we can walk forward.
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const edits = [];
  let i = 0, j = 0, pos = 0;
  let cur = null; // open edit
  let gap = null; // equal whitespace token right after an edit, may get merged

  const open = () => {
    if (cur) return;
    if (gap && edits.length) {
      // Only whitespace separates this change from the previous one: merge them.
      cur = edits.pop();
      cur.end = gap.end;
      cur.replacement += gap.text;
    } else {
      cur = { start: pos, end: pos, replacement: '' };
    }
  };
  const close = () => { if (cur) { edits.push(cur); cur = null; } };

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      gap = /^\s+$/.test(a[i]) && edits.length && edits.at(-1).end === pos
        ? { end: pos + a[i].length, text: a[i] }
        : null;
      pos += a[i].length; i++; j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      open(); gap = null;
      cur.replacement += b[j]; j++;
    } else {
      open(); gap = null;
      pos += a[i].length; cur.end = pos; i++;
    }
  }
  close();
  return edits;
}

export function applyEdits(text, edits) {
  let out = text;
  for (const e of [...edits].sort((x, y) => y.start - x.start)) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return out;
}
