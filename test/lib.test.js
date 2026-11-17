import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, diffEdits, applyEdits } from '../extension/lib/diff.js';
import { splitSentences } from '../extension/lib/sentences.js';
import { checkText } from '../extension/lib/check.js';
import { cleanReply, correct, REWRITE_PROMPTS, REWRITE_BOUNDS } from '../extension/lib/ollama.js';

test('tokenize covers every character', () => {
  for (const s of ['Hello,  world!', "It's João's café — 3.5 km\n", '', '   ', 'emoji 🙂 here']) {
    assert.equal(tokenize(s).join(''), s);
  }
});

test('identical text gives no edits', () => {
  assert.deepEqual(diffEdits('All good here.', 'All good here.'), []);
});

test('single word replacement', () => {
  assert.deepEqual(diffEdits('She go home.', 'She goes home.'), [{ start: 4, end: 6, replacement: 'goes' }]);
});

test('insertion and deletion', () => {
  assert.deepEqual(diffEdits('I went store.', 'I went to the store.'), [{ start: 7, end: 7, replacement: 'to the ' }]);
  assert.deepEqual(diffEdits('the the cat', 'the cat'), [{ start: 4, end: 8, replacement: '' }]);
});

test('changes separated only by whitespace merge into one edit', () => {
  assert.deepEqual(diffEdits('He have went.', 'He has gone.'), [{ start: 3, end: 12, replacement: 'has gone' }]);
});

test('applying edits reproduces the correction', () => {
  const pairs = [
    ['New and new technology has been introduced to the society.', 'New technology has been introduced to society.'],
    ['i dont no what your talking about', "I don't know what you're talking about."],
    ['Their going too the park, isnt it', "They're going to the park, aren't they?"],
    ['Café owners was happy 🙂', 'Café owners were happy 🙂'],
    ['', 'Something'],
    ['Something', ''],
  ];
  for (const [a, b] of pairs) assert.equal(applyEdits(a, diffEdits(a, b)), b);
});

test('splitSentences keeps offsets and trims', () => {
  const text = '  Hi there. I am fine!\n\nNext one';
  const parts = splitSentences(text);
  assert.deepEqual(parts.map((p) => p.text), ['Hi there.', 'I am fine!', 'Next one']);
  for (const p of parts) assert.equal(text.slice(p.start, p.start + p.text.length), p.text);
});

test('checkText maps edits to full-text offsets', async () => {
  const text = 'This is fine. She go home.';
  const fixes = { 'This is fine.': 'This is fine.', 'She go home.': 'She goes home.' };
  const edits = await checkText(text, async (s) => fixes[s]);
  assert.deepEqual(edits, [{ start: 18, end: 20, replacement: 'goes' }]);
  assert.equal(applyEdits(text, edits), 'This is fine. She goes home.');
});

test('cleanReply strips wrappers and rejects rambling', () => {
  assert.equal(cleanReply('Corrected text: She goes home.', 'She go home.'), 'She goes home.');
  assert.equal(cleanReply('"She goes home."', 'She go home.'), 'She goes home.');
  assert.equal(cleanReply('"Hi," he said.', '"Hi," he sayed.'), '"Hi," he said.');
  const ramble = 'Sure! Here is the corrected sentence along with a long explanation of every change.';
  assert.equal(cleanReply(ramble, 'She go home.'), 'She go home.');
});

test('cleanReply with rewrite bounds keeps big changes, still rejects rambling and echoes', () => {
  const long = 'I wanted to let you know that I will not be able to attend the meeting tomorrow.';
  const short = "I can't attend tomorrow's meeting.";
  assert.equal(cleanReply(short, long), long); // grammar bounds reject it
  assert.equal(cleanReply(`Rewritten text: ${short}`, long, REWRITE_BOUNDS), short);
  assert.equal(cleanReply('x'.repeat(long.length * 3), long, REWRITE_BOUNDS), long);
  assert.equal(cleanReply(REWRITE_PROMPTS.shorter, long, REWRITE_BOUNDS), long);
  for (const prompt of Object.values(REWRITE_PROMPTS)) assert.match(prompt, /Reply with the rewritten text only/);
});

test('correct gives back the original when the model hits num_predict, and scales the cap by bounds', async () => {
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message: { content: 'She goes to the' }, done_reason: 'length' }));
  };
  try {
    const text = 'She go to the shop every day.';
    assert.equal(await correct(text, { model: 'm' }), text);
    assert.equal(await correct(text, { model: 'm', bounds: REWRITE_BOUNDS }), text);
    assert.equal(bodies[0].options.num_predict, Math.ceil(text.length / 2) + 32); // grammar cap unchanged
    assert.ok(bodies[1].options.num_predict > bodies[0].options.num_predict);
  } finally {
    globalThis.fetch = realFetch;
  }
});
