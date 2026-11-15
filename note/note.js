const $ = (s) => document.querySelector(s);
const list = $('#tasks');
const CHEV = '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';

const state = { title: '', color: '', tasks: [], deleted: [] };
let editing = null; // id of task being edited
let origText = '';
let dragId = null;
let seq = 0;
const MAX_DELETED = 50;
const newId = () => Date.now().toString(36) + (seq++).toString(36);
// main debounces the disk write; sending every change means typed text survives a renderer crash
const changed = () => api.update({ title: state.title, tasks: state.tasks, deleted: state.deleted });

/* ---------- colour ---------- */
function applyColor(hex) {
  state.color = hex;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const root = document.documentElement.style;
  root.setProperty('--bg', hex);
  root.setProperty('--ink', lum > 0.6 ? '#2f2a24' : '#fff');
  root.setProperty('--ink-soft', lum > 0.6 ? 'rgba(47,42,36,.45)' : 'rgba(255,255,255,.55)');
}

/* ---------- state helpers ---------- */
const find = (id) => state.tasks.findIndex((t) => t.id === id);
const spanOf = (id) => list.querySelector(`[data-id="${id}"] .label`);

function addTask(at, text = '', edit = true) {
  const t = { id: newId(), text, done: false, pri: 2 };
  state.tasks.splice(at, 0, t);
  render();
  if (edit) startEdit(t.id);
  changed();
  return t;
}

function removeTask(id, withUndo) {
  const i = find(id);
  if (i < 0) return;
  const [t] = state.tasks.splice(i, 1);
  if (withUndo && t.text) {
    state.deleted.push({ task: t, index: i, at: Date.now() });
    if (state.deleted.length > MAX_DELETED) state.deleted.splice(0, state.deleted.length - MAX_DELETED);
    toast('Task deleted', () => {
      const k = state.deleted.findIndex((d) => d.task.id === t.id);
      if (k < 0) return; // already restored from the menu
      state.deleted.splice(k, 1);
      state.tasks.splice(Math.min(i, state.tasks.length), 0, t);
      render(); changed();
    });
  }
  render(); changed();
}

/* ---------- editing ---------- */
function startEdit(id) {
  const span = spanOf(id);
  if (!span) return;
  editing = id;
  origText = state.tasks[find(id)].text;
  span.contentEditable = 'plaintext-only';
  span.focus();
  const r = document.createRange();
  r.selectNodeContents(span); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

// commit=false restores the old text. Empty tasks are dropped.
function finishEdit(id, commit = true) {
  if (editing !== id) return;
  editing = null;
  const span = spanOf(id);
  const t = state.tasks[find(id)];
  if (!span || !t) return;
  span.removeAttribute('contenteditable');
  const text = commit ? span.innerText.replace(/\s*\n\s*/g, ' ').trim() : origText;
  if (!text) {
    // drop just this row: a full render() here (blur fires on mousedown) would swallow the click that caused it
    state.tasks.splice(find(id), 1);
    span.closest('li').remove();
    return changed();
  }
  t.text = text; span.textContent = text; changed();
}

function onKey(e, id) {
  const span = e.currentTarget;
  if (e.isComposing) return; // IME: Enter confirms the composition
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!span.innerText.trim()) return;
    finishEdit(id);
    addTask(find(id) + 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    finishEdit(id, false);
  } else if (e.key === 'Backspace' && !span.innerText.trim()) {
    e.preventDefault();
    const i = find(id);
    editing = null;
    removeTask(id, false);
    if (i > 0) startEdit(state.tasks[i - 1].id);
  }
}

function onPaste(e, id) {
  e.preventDefault();
  const lines = e.clipboardData.getData('text/plain').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return document.execCommand('insertText', false, lines[0] || '');
  document.execCommand('insertText', false, lines[0]);
  finishEdit(id);
  const at = find(id) + 1;
  state.tasks.splice(at, 0, ...lines.slice(1).map((text) => ({ id: newId(), text, done: false, pri: 2 })));
  render(); changed();
}

/* ---------- render ---------- */
function row(t) {
  const li = document.createElement('li');
  li.className = 'task'; li.dataset.id = t.id;
  li.innerHTML = `<span class="grip" title="Drag to reorder">⋮⋮</span>
    <button class="dot p${t.pri}" title="Priority"></button>
    <div class="text"><span class="label${t.done ? ' done' : ''}"></span></div>
    <button class="x" title="Delete task">×</button>
    <button class="chev" title="Extra info">${CHEV}</button>`;
  const span = li.querySelector('.label');
  span.textContent = t.text;

  li.querySelector('.dot').onclick = (e) => {
    t.pri = (t.pri + 1) % 3; // red -> yellow -> green -> red
    e.currentTarget.className = `dot p${t.pri}`; changed();
  };
  li.querySelector('.x').onclick = () => removeTask(t.id, true);
  li.querySelector('.chev').onclick = async () => {
    const link = await api.openInfo(t.id); // main creates/renames the file and owns the link
    if (link) { Object.assign(t, link); changed(); }
  };

  // single click toggles done; the delay lets a double-click (edit) cancel it. Timer per row so quick ticks don't cancel each other.
  let clickTimer = null;
  const toggle = () => { t.done = !t.done; span.classList.toggle('done', t.done); changed(); };
  span.onclick = () => {
    if (editing === t.id) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(toggle, 250);
  };
  span.ondblclick = () => { clearTimeout(clickTimer); if (editing !== t.id) startEdit(t.id); };
  span.tabIndex = 0; // keyboard: Space toggles, Enter edits (onKey handles keys while editing)
  span.addEventListener('keydown', (e) => {
    if (editing === t.id) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); } else if (e.key === 'Enter') { e.preventDefault(); startEdit(t.id); }
  });
  span.oninput = () => { t.text = span.innerText.replace(/\s*\n\s*/g, ' ').trim(); changed(); };
  span.onkeydown = (e) => onKey(e, t.id);
  span.onpaste = (e) => onPaste(e, t.id);
  span.onblur = () => { if (document.hasFocus()) finishEdit(t.id); }; // alt-tab away keeps the edit open

  // drag-reorder, armed only from the grip
  const grip = li.querySelector('.grip');
  grip.onmousedown = () => { li.draggable = true; };
  grip.onmouseup = () => { li.draggable = false; }; // plain click: no dragend to disarm it
  li.ondragstart = (e) => { dragId = t.id; e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); };
  li.ondragend = () => { dragId = null; li.draggable = false; li.classList.remove('dragging'); clearMarks(); };
  return li;
}

let hinted = new Set();
async function refreshHints() {
  hinted = new Set(await api.hints());
  list.querySelectorAll('.task').forEach((li) => li.querySelector('.chev').classList.toggle('has', hinted.has(li.dataset.id)));
}
window.addEventListener('focus', refreshHints);

function render() {
  if (editing) finishEdit(editing); // the focused span is about to be replaced
  list.replaceChildren(...state.tasks.map(row));
  list.querySelectorAll('.task').forEach((li) => li.querySelector('.chev').classList.toggle('has', hinted.has(li.dataset.id)));
  const add = document.createElement('li');
  add.className = 'add';
  add.innerHTML = '<span>+</span><span>add task</span>';
  add.tabIndex = 0;
  add.onclick = () => addTask(state.tasks.length);
  add.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addTask(state.tasks.length); } };
  list.append(add);
}

/* ---------- drag reorder ---------- */
const clearMarks = () => list.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
const dropTarget = (e) => {
  const li = e.target.closest('li.task');
  if (!li || li.dataset.id === dragId) return null;
  const r = li.getBoundingClientRect();
  return { li, before: e.clientY < r.top + r.height / 2 };
};
list.ondragover = (e) => {
  if (!dragId) return;
  e.preventDefault(); clearMarks();
  const d = dropTarget(e);
  if (d) d.li.classList.add(d.before ? 'drop-before' : 'drop-after');
};
list.ondrop = (e) => {
  const d = dropTarget(e);
  if (!dragId || !d) return;
  e.preventDefault();
  const [moved] = state.tasks.splice(find(dragId), 1);
  const to = find(d.li.dataset.id) + (d.before ? 0 : 1);
  state.tasks.splice(to, 0, moved);
  render(); changed();
};

/* ---------- toast ---------- */
function toast(msg, undo) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${msg}</span><button>Undo</button>`;
  const kill = () => el.remove();
  el.querySelector('button').onclick = () => { undo(); kill(); };
  $('#toasts').replaceChildren(el); // one at a time so they never bury a small note
  setTimeout(kill, 5000);
}

/* ---------- window chrome ---------- */
$('#title').oninput = (e) => { state.title = e.target.value; changed(); };
$('#title').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
function showPin(pinned) {
  document.body.classList.toggle('pinned', pinned);
  $('#pin').classList.toggle('on', pinned);
  $('#pin').title = pinned ? 'Pinned: locked in place. Click to float on top.' : 'Floating on top. Click to pin in place.';
}
$('#pin').onclick = async () => showPin(await api.pin());
$('#close').onclick = () => api.close();
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, [contenteditable]')) return; // keep native cut/copy/paste while typing
  e.preventDefault(); api.menu();
});
api.onColor((hex) => { state.color = hex; applyColor(hex); });
api.onRestoreTask((id) => {
  const k = state.deleted.findIndex((d) => d.task.id === id);
  if (k < 0) return;
  const [d] = state.deleted.splice(k, 1);
  state.tasks.splice(Math.min(d.index, state.tasks.length), 0, d.task);
  render(); changed();
});

(async () => {
  const { note, fresh } = await api.init();
  Object.assign(state, { title: note.title, tasks: note.tasks, deleted: note.deleted });
  $('#title').value = state.title;
  applyColor(note.color);
  showPin(note.pinned);
  render();
  refreshHints();
  if (fresh) addTask(0); // new note: one empty task focused
})();
