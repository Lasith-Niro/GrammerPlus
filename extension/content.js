// On-demand check: select text, press the shortcut or use the context menu, review, Replace.
(() => {
  // The service worker may inject this file into a tab that already has it; run once per frame.
  if (window.__grammerPlusLoaded) return;
  window.__grammerPlusLoaded = true;
  const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', '']);
  // Keys must match REWRITE_PROMPTS in lib/ollama.js (this file can't import it). '' = grammar check.
  const STYLES = { '': 'Grammar', clearer: 'Clearer', shorter: 'Shorter', formal: 'Formal', friendly: 'Friendly' };
  const MAC = /Mac/.test(navigator.userAgent);
  // Shortcut label in the platform's own notation. Shown on the buttons; aria-hidden there, since
  // aria-keyshortcuts already tells screen readers and the hint shouldn't change the button's name.
  const keyHint = (alt, key) => (MAC ? `${alt ? '⌥' : '⌘'}${key}` : `${alt ? 'Alt' : 'Ctrl'}+${key}`);
  const kbd = (text) => Object.assign(document.createElement('kbd'), { textContent: text, ariaHidden: 'true' });
  const STALE = 'The text changed since the check. Use Copy and paste the suggestion yourself, or select the text and check again.';
  let card = null;
  let seq = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'check-selection') run();
  });

  async function run() {
    const target = readSelection();
    if (!target) return;
    const { disabledSites = [] } = await chrome.storage.sync.get('disabledSites');
    if (disabledSites.includes(location.hostname)) return;
    check(target, '');
  }

  async function check(target, style) {
    const base = { style, onStyle: (s) => check(target, s) };
    showCard(target.rect, { ...base, status: style ? 'Rewriting…' : 'Checking…' });
    const mine = ++seq;
    const res = await chrome.runtime.sendMessage({ type: 'check', text: target.text, style: style || undefined });
    if (!card || mine !== seq) return; // closed, or superseded by a newer check
    if (res.error) return showCard(target.rect, { ...base, status: res.error });
    if (res.corrected === target.text) return showCard(target.rect, { ...base, status: style ? 'No changes suggested.' : 'No issues found.' });
    showCard(target.rect, {
      ...base, text: target.text, edits: res.edits, corrected: res.corrected, onCopy: () => copy(res.corrected),
      onReplace: target.editable && (() => replace(target, res.corrected)),
    });
  }

  // Returns {text, rect, editable, el?, start?, end?, range?} or null when nothing usable is selected.
  function readSelection() {
    const el = document.activeElement;
    const isField = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type));
    if (isField) {
      const { selectionStart: start, selectionEnd: end } = el;
      if (start === end || el.readOnly || el.disabled) return null;
      return { text: el.value.slice(start, end), rect: el.getBoundingClientRect(), editable: true, el, start, end };
    }
    if (el instanceof HTMLInputElement) return null; // password and other non-text inputs are never read
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0).cloneRange();
    const node = range.commonAncestorContainer;
    const host = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    // rangeText is what replace() compares against: Selection.toString() adds newlines between blocks, Range.toString() doesn't.
    return { text: sel.toString(), rangeText: range.toString(), rect: range.getBoundingClientRect(), editable: !!host?.isContentEditable, range };
  }

  function replace(target, corrected) {
    if (target.el) {
      const { el, start, end, text } = target;
      if (el.value.slice(start, end) !== text) return STALE;
      el.focus();
      el.setSelectionRange(start, end);
      // execCommand keeps undo history and fires the input events frameworks listen for.
      if (!document.execCommand('insertText', false, corrected)) {
        el.setRangeText(corrected, start, end, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else {
      const { range, rangeText } = target;
      if (range.toString() !== rangeText) return STALE;
      const host = range.commonAncestorContainer;
      (host.nodeType === Node.ELEMENT_NODE ? host : host.parentElement).closest('[contenteditable]')?.focus();
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, corrected);
    }
    return null;
  }

  // Returns the status message to show.
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return `Copied. Paste it with ${MAC ? '⌘V' : 'Ctrl+V'}.`;
    } catch {
      return "Couldn't copy on this page."; // e.g. plain-http pages or iframes that block clipboard access
    }
  }

  function closeCard() {
    card?.remove();
    card = null;
    document.removeEventListener('keydown', onKey, true);
  }
  // Card shortcuts work while focus stays in the page's field, so each needs a modifier: Alt+1–5 picks a style
  // (e.code, because Option+key on a Mac types a symbol), Alt+C presses Copy, Cmd/Ctrl+Enter presses Replace.
  const onKey = (e) => {
    if (e.key === 'Escape') return closeCard();
    const root = card.shadowRoot;
    let btn = null;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) btn = root.querySelector('.replace:not([hidden])');
    else if (e.altKey && !e.metaKey && !e.ctrlKey && /^Digit[1-5]$/.test(e.code)) btn = root.querySelectorAll('.styles button')[e.code.at(-1) - 1];
    else if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyC') btn = root.querySelector('.copy:not([hidden])');
    if (!btn) return; // not ours: let the page have it (e.g. Cmd+Enter to send while no suggestion is ready)
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) btn.click();
  };

  function showCard(rect, { status, text, edits, corrected, style, onStyle, onCopy, onReplace }) {
    if (!card) {
      card = document.createElement('grammerplus-card');
      card.attachShadow({ mode: 'open' });
      document.documentElement.append(card);
      document.addEventListener('keydown', onKey, true);
    }
    const root = card.shadowRoot;
    const focusedStyle = root.activeElement?.dataset.style; // re-render below would drop a keyboard user's focus
    root.innerHTML = `<style>${CSS}</style>
      <div class="card" role="dialog" aria-label="GrammerPlus suggestions">
        <div class="styles" role="group" aria-label="Suggestion type"></div>
        <div class="body"></div>
        <p class="status" role="status" aria-live="polite"></p>
        <div class="actions">
          <button class="copy" type="button" aria-keyshortcuts="Alt+C">Copy</button>
          <button class="replace" type="button" aria-keyshortcuts="Meta+Enter Control+Enter">Replace</button>
          <button class="close" type="button" aria-keyshortcuts="Escape">Close</button>
        </div>
      </div>`;

    root.querySelector('.replace').append(kbd(keyHint(false, MAC ? '↩' : 'Enter')));
    root.querySelector('.close').append(kbd('Esc'));
    root.querySelector('.copy').append(kbd(keyHint(true, 'C')));
    root.querySelector('.styles').append(...Object.entries(STYLES).map(([key, label], i) => {
      const b = Object.assign(document.createElement('button'), { type: 'button' });
      b.append(label, kbd(keyHint(true, i + 1)));
      b.setAttribute('aria-keyshortcuts', `Alt+${i + 1}`);
      b.setAttribute('aria-pressed', String(key === style));
      b.dataset.style = key;
      b.onclick = () => onStyle(key);
      return b;
    }));

    const body = root.querySelector('.body');
    if (style && corrected) {
      // A rewrite's word diff is mostly red and green blocks; show the new text, original folded below.
      const orig = document.createElement('details');
      orig.append(Object.assign(document.createElement('summary'), { textContent: 'Original' }), text);
      body.append(corrected, orig);
    } else if (edits) {
      let pos = 0;
      for (const e of edits) {
        body.append(text.slice(pos, e.start));
        if (e.end > e.start) body.append(Object.assign(document.createElement('del'), { textContent: text.slice(e.start, e.end) }));
        if (e.replacement) body.append(Object.assign(document.createElement('ins'), { textContent: e.replacement }));
        pos = e.end;
      }
      body.append(text.slice(pos));
    } else {
      body.remove();
    }
    root.querySelector('.status').textContent = status ?? '';

    const replaceBtn = root.querySelector('.replace');
    replaceBtn.hidden = !onReplace;
    replaceBtn.onclick = () => {
      const problem = onReplace();
      if (problem) root.querySelector('.status').textContent = problem;
      else closeCard();
    };
    const copyBtn = root.querySelector('.copy');
    copyBtn.hidden = !onCopy;
    copyBtn.onclick = async () => { root.querySelector('.status').textContent = await onCopy(); };
    root.querySelector('.close').onclick = closeCard;
    if (focusedStyle !== undefined) root.querySelector(`.styles [data-style="${focusedStyle}"]`).focus();
    // Keep the page's selection while clicking card buttons.
    root.querySelector('.card').addEventListener('mousedown', (e) => e.preventDefault());

    // Place below the selection, flipped above if it would overflow the viewport.
    const box = root.querySelector('.card');
    const top = rect.bottom + 8 + box.offsetHeight > innerHeight ? Math.max(8, rect.top - 8 - box.offsetHeight) : rect.bottom + 8;
    box.style.top = `${top}px`;
    box.style.left = `${Math.min(Math.max(8, rect.left), innerWidth - box.offsetWidth - 8)}px`;
  }

  const CSS = `
    .card { position: fixed; z-index: 2147483647; max-width: min(480px, calc(100vw - 16px)); box-sizing: border-box;
      padding: 12px; border-radius: 8px; font: 14px/1.5 system-ui, sans-serif; color: #1a1a1a; background: #fff;
      border: 1px solid #d0d0d0; box-shadow: 0 4px 16px rgba(0,0,0,.15); }
    .body { white-space: pre-wrap; word-break: break-word; max-height: 40vh; overflow: auto; margin-bottom: 8px; }
    del { color: #b3261e; background: #fde8e7; }
    ins { color: #146c2e; background: #e3f5e8; text-decoration: none; }
    .status { margin: 0 0 8px; color: #555; }
    .status:empty { display: none; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    .styles { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
    .styles button { padding: 2px 8px; font-size: 13px; }
    kbd { margin-left: 5px; font: 11px system-ui, sans-serif; opacity: .65; }
    .styles button[aria-pressed="true"] { border-color: #1a5fb4; box-shadow: inset 0 0 0 1px #1a5fb4; }
    details { margin-top: 8px; color: #555; }
    summary { cursor: pointer; }
    button { font: inherit; padding: 4px 12px; border-radius: 6px; border: 1px solid #c0c0c0; background: #f5f5f5; color: inherit; cursor: pointer; }
    button.replace { background: #1a5fb4; border-color: #1a5fb4; color: #fff; }
    button:focus-visible { outline: 2px solid #1a5fb4; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .card { color: #eee; background: #242424; border-color: #444; }
      .status, details { color: #aaa; }
      .styles button[aria-pressed="true"] { border-color: #8ab4f8; box-shadow: inset 0 0 0 1px #8ab4f8; }
      del { color: #ffb4ab; background: #5c1a16; }
      ins { color: #a6e3b5; background: #17421f; }
      button { background: #333; border-color: #555; }
    }`;
})();
