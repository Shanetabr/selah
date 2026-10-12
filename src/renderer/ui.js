// Small DOM helpers. Electron has no window.prompt, so text entry and menus
// are built here.

export const $ = (sel, root) => (root || document).querySelector(sel);

// el('div.cls#id', { title: 'x', onclick: fn }, child, 'text', ...)
export function el(spec, props, ...children) {
  const [tagAndId, ...classes] = spec.split('.');
  const [tag, id] = tagAndId.split('#');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (k === 'style') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k in node) node[k] = v;
      else node.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

let toastTimer = null;
export function toast(text, kind) {
  const box = $('#toast');
  box.textContent = text;
  box.className = kind || '';
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), kind === 'error' || kind === 'long' ? 7000 : 3000);
}

function closeMenu() {
  const open = $('.menu');
  if (open) open.remove();
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onMenuKey, true);
}

function onDocDown(e) {
  if (!e.target.closest('.menu')) closeMenu();
}

function onMenuKey(e) {
  if (e.key === 'Escape') closeMenu();
}

// items: [{ label, action, danger, swatch }] or '-' for a separator
export function menu(x, y, items) {
  closeMenu();
  const box = el('div.menu');
  for (const it of items) {
    if (it === '-') {
      box.append(el('div.sep'));
      continue;
    }
    box.append(
      el(
        'button' + (it.danger ? '.danger' : ''),
        {
          onclick: () => {
            closeMenu();
            it.action();
          },
        },
        it.swatch ? el('span.swatch', { style: { background: it.swatch } }) : null,
        it.label
      )
    );
  }
  document.body.append(box);
  const r = box.getBoundingClientRect();
  box.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  box.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onMenuKey, true);
  });
}

// Modal with arbitrary content. Returns { close }.
export function modal(title, body, opts) {
  const overlay = $('#overlay');
  const close = () => {
    overlay.hidden = true;
    overlay.replaceChildren();
    document.removeEventListener('keydown', onKey, true);
    if (opts && opts.onClose) opts.onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !(opts && opts.locked)) {
      e.stopPropagation();
      close();
    }
  };
  const head = el('div.modal-head', null, el('span', null, title), opts && opts.locked ? null : el('button.x', { onclick: close, title: 'Close' }, '×'));
  overlay.replaceChildren(el('div.modal', null, head, el('div.modal-body', null, body)));
  overlay.hidden = false;
  document.addEventListener('keydown', onKey, true);
  return { close };
}

// Resolves with the entered text, or null if cancelled.
export function askText(title, initial, suggestions) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const input = el('input', { type: 'text', value: initial || '', spellcheck: false });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(input.value.trim() || null);
    });
    const chips = (suggestions || []).map((s) => el('button.chip', { onclick: () => finish(s) }, s));
    const body = el(
      'div.ask',
      null,
      input,
      chips.length ? el('div.chips', null, chips) : null,
      el('div.row-end', null, el('button', { onclick: () => finish(null) }, 'Cancel'), el('button.primary', { onclick: () => finish(input.value.trim() || null) }, 'OK'))
    );
    const m = modal(title, body, { onClose: () => finish(null) });
    input.focus();
    input.select();
  });
}

export function fmtTime(sec, tenths) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  if (tenths) return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  return m + ':' + String(Math.floor(s)).padStart(2, '0');
}

export function gainToDb(g) {
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}

export function dbToGain(db) {
  return db <= -60 ? 0 : Math.pow(10, db / 20);
}

export function fmtDb(g) {
  const db = gainToDb(g);
  if (db === -Infinity) return '-inf';
  return (db > 0 ? '+' : '') + db.toFixed(1);
}
