const $ = (s) => document.querySelector(s);
const list = $('#tasks');
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  chev: svg('M9 5l7 7-7 7'),
  x: svg('M6 6l12 12M18 6L6 18'),
  plus: svg('M12 5v14M5 12h14'),
  check: svg('M5 12l5 5 9-10'),
  grip: svg('M9 6v.01M15 6v.01M9 12v.01M15 12v.01M9 18v.01M15 18v.01'),
};
const PRIORITY = ['High', 'Medium', 'Low']; // task.pri 0, 1, 2

const state = { title: '', tasks: [] };
let editing = null; // id of task being edited
let origText = '';
let dragId = null;
let closing = null; // timer while "Note closed · Undo" is showing
let spell = false; // spellcheck while typing (Settings)
let seq = 0;
const newId = () => Date.now().toString(36) + (seq++).toString(36);
// main debounces the disk write; sending every change means typed text survives a renderer crash
const changed = () => { footer(); api.update({ title: state.title, tasks: state.tasks }); };
// the hint shows on an empty note, "Clear completed" once something is ticked
function footer() {
  $('#hint').hidden = state.tasks.some((t) => t.text);
  const clear = list.querySelector('.clear');
  if (clear) clear.hidden = !state.tasks.some((t) => t.done);
}

/* ---------- undo: each change leaves a function that takes it back; Ctrl+Z runs the newest ---------- */
const undos = [];
const remember = (fn) => { undos.push(fn); if (undos.length > 50) undos.shift(); return fn; };
const run = (fn) => { if (undos.includes(fn)) undos.splice(undos.indexOf(fn), 1); fn(); };
// for a change to one task: looked up by id again, so it still works after other edits (and does nothing if the task is gone)
const revert = (id, fn) => remember(() => { const t = state.tasks[find(id)]; if (t) { fn(t); render(); changed(); } });
function undo() {
  if (closing) return cancelClose();
  if (undos.length) run(undos.at(-1));
}

/* ---------- colour ---------- */
function applyColor(hex) {
  document.documentElement.style.setProperty('--bg', hex);
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

// History ids come back from main as a promise; this builds the Undo for them and shows the toast.
function offerUndo(message, ids) {
  const back = remember(async () => {
    $('#toasts').replaceChildren();
    for (const id of [].concat(await ids)) if (id) api.restore(id); // main puts each task back and sends it here through onSync
  });
  toast(message, () => run(back));
}

// withUndo: the task goes to History and a toast offers Undo. Otherwise (an empty row) it is just dropped.
function removeTask(id, withUndo) {
  const i = find(id);
  if (i < 0) return;
  const [t] = state.tasks.splice(i, 1);
  if (withUndo && t.text) {
    offerUndo('Task deleted', api.deleteTask(id)); // main moves its own copy to History; sent before any later update
    render();
  } else { render(); changed(); }
  (list.querySelectorAll('.label')[Math.min(i, state.tasks.length - 1)] || list.querySelector('.add button'))?.focus();
}

function clearDone() {
  const n = state.tasks.filter((t) => t.done).length;
  if (!n || closing) return;
  if (editing) finishEdit(editing);
  const ids = api.clearDone();
  state.tasks = state.tasks.filter((t) => !t.done);
  render();
  offerUndo(`${n} completed task${n === 1 ? '' : 's'} moved to History`, ids);
}

function move(id, to) {
  const from = find(id);
  if (from < 0 || to < 0 || to >= state.tasks.length || to === from) return false;
  state.tasks.splice(to, 0, state.tasks.splice(from, 1)[0]);
  render(); changed();
  return true;
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
  const old = origText;
  if (old && old !== text) revert(id, (x) => { x.text = old; });
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
    spanOf(id)?.focus();
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
  li.innerHTML = `<span class="grip" title="Drag to reorder (Alt+Up, Alt+Down)">${ICON.grip}</span>
    <button class="check" tabindex="-1" aria-hidden="true" title="Tick off">${ICON.check}</button>
    <button class="dot"></button>
    <div class="text"><span class="label" role="checkbox"></span></div>
    <button class="x" title="Delete task (Del)" aria-label="Delete task">${ICON.x}</button>
    <button class="chev" title="Open this task's notes file" aria-label="Open notes file">${ICON.chev}</button>`;
  const span = li.querySelector('.label');
  span.textContent = t.text;
  span.spellcheck = spell;

  const dot = li.querySelector('.dot');
  const showPri = () => {
    dot.className = `dot p${t.pri}`;
    dot.title = `Priority: ${PRIORITY[t.pri]}. Click to change.`;
    dot.setAttribute('aria-label', dot.title);
  };
  showPri();
  dot.onclick = () => { // high -> medium -> low -> high
    const old = t.pri;
    revert(t.id, (x) => { x.pri = old; });
    t.pri = (t.pri + 1) % 3; showPri(); changed();
  };
  li.querySelector('.x').onclick = () => removeTask(t.id, true);
  li.querySelector('.chev').onclick = async () => {
    const link = await api.openInfo(t.id); // main creates/renames the file and owns the link
    if (link) { Object.assign(t, link); changed(); }
  };

  const showDone = () => { li.classList.toggle('done', t.done); span.setAttribute('aria-checked', t.done); };
  showDone();
  const toggle = () => {
    const was = t.done, at = t.doneAt;
    revert(t.id, (x) => { x.done = was; if (was) x.doneAt = at; else delete x.doneAt; });
    t.done = !t.done;
    if (t.done) t.doneAt = Date.now(); else delete t.doneAt;
    showDone(); changed();
  };
  li.querySelector('.check').onclick = toggle; // the box ticks at once
  // a click on the text ticks too, after a moment: the delay lets a double-click (edit) cancel it. Timer per row so quick ticks don't cancel each other.
  let clickTimer = null;
  span.onclick = () => {
    if (editing === t.id) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(toggle, 250);
  };
  span.ondblclick = () => { clearTimeout(clickTimer); if (editing !== t.id) startEdit(t.id); };
  span.tabIndex = 0; // keyboard: Space ticks, Enter edits, Del deletes, Alt+arrows move
  // one handler for both states: with two, the Enter that starts an edit would also reach the editing handler and end it
  span.onkeydown = (e) => {
    if (editing === t.id) return onKey(e, t.id);
    const step = e.altKey && { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (e.key === ' ') toggle();
    else if (e.key === 'Enter') startEdit(t.id);
    else if (e.key === 'Delete') removeTask(t.id, true);
    else if (step) {
      const from = find(t.id);
      if (move(t.id, from + step)) { revert(t.id, () => move(t.id, from)); spanOf(t.id)?.focus(); }
    } else return;
    e.preventDefault();
  };
  span.oninput = () => { t.text = span.innerText.replace(/\s*\n\s*/g, ' ').trim(); changed(); };
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
const markFiles = () => list.querySelectorAll('.task').forEach((li) => li.querySelector('.chev').classList.toggle('has', hinted.has(li.dataset.id)));
async function refreshHints() {
  hinted = new Set(await api.hints());
  markFiles();
}
window.addEventListener('focus', refreshHints);

function render() {
  if (editing) finishEdit(editing); // the focused span is about to be replaced
  list.replaceChildren(...state.tasks.map(row));
  markFiles();
  const add = document.createElement('li');
  add.className = 'add';
  add.innerHTML = `<button title="Add task (Ctrl+N)">${ICON.plus}<span>Add task</span></button><button class="clear" title="Move the ticked tasks to History">Clear completed</button>`;
  add.firstChild.onclick = () => addTask(state.tasks.length);
  add.lastChild.onclick = clearDone;
  list.append(add);
  footer();
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
  const id = dragId, from = find(id);
  const target = find(d.li.dataset.id);
  const to = (d.before ? target : target + 1) - (from < target ? 1 : 0); // its place once it has been taken out
  if (move(id, to)) revert(id, () => move(id, from));
};

/* ---------- toast ---------- */
function toast(msg, onUndo, ms = 5000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = '<span></span><button title="Undo (Ctrl+Z)">Undo</button>';
  el.firstChild.textContent = msg;
  el.querySelector('button').onclick = () => onUndo();
  $('#toasts').replaceChildren(el); // one at a time so they never bury a small note
  setTimeout(() => el.remove(), ms);
}

/* ---------- closing: the note stays for a moment so the close can be undone ---------- */
function requestClose() {
  if (closing) return;
  if (!state.title && !state.tasks.some((t) => t.text)) return api.close(); // nothing to lose
  if (editing) finishEdit(editing);
  document.body.classList.add('closing');
  closing = setTimeout(() => api.close(), 4000);
  toast('Note closed. It is in History.', cancelClose, 4000);
}
function cancelClose() {
  clearTimeout(closing);
  closing = null;
  document.body.classList.remove('closing');
  $('#toasts').replaceChildren();
}

/* ---------- window chrome and shortcuts ---------- */
$('#title').oninput = (e) => { state.title = e.target.value; changed(); };
$('#title').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
function showPin(pinned) {
  document.body.classList.toggle('pinned', pinned);
  $('#pin').classList.toggle('on', pinned);
  $('#pin').title = pinned ? 'Stuck to the desktop, behind other windows. Click to float on top.' : 'Floating above other windows. Click to stick it to the desktop.';
  $('#pin').setAttribute('aria-pressed', pinned);
}
$('#pin').onclick = async () => showPin(await api.pin());
$('#close').onclick = requestClose;
$('#help').onclick = () => api.show('help');
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, [contenteditable]')) return; // keep native cut/copy/paste while typing
  e.preventDefault(); api.menu();
});
document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, [contenteditable]');
  const key = e.key.toLowerCase();
  if (e.key === 'F1') api.show('help');
  else if (!e.ctrlKey || e.altKey || e.shiftKey) return;
  else if (key === 'n' && !closing) addTask(state.tasks.length);
  else if (key === 'f') api.show('history');
  else if (key === 'z' && !typing) undo(); // while typing, Ctrl+Z undoes the typing
  else return;
  e.preventDefault();
});
api.onColor(applyColor);
api.onCloseRequest(requestClose);
api.onClearRequest(clearDone);
api.onSpellcheck((on) => { spell = on; list.querySelectorAll('.label').forEach((s) => { s.spellcheck = on; }); });
// main changed a task of this note (restored from History, unticked or deleted there)
api.onSync(({ op, task, index, id }) => {
  const i = find(task?.id ?? id);
  if (op === 'remove') { if (i >= 0) state.tasks.splice(i, 1); } else if (i >= 0) state.tasks[i] = task; else state.tasks.splice(Math.min(index ?? state.tasks.length, state.tasks.length), 0, task);
  render(); changed();
});

(async () => {
  const { note, fresh, spellcheck } = await api.init();
  Object.assign(state, { title: note.title, tasks: note.tasks });
  spell = spellcheck;
  $('#title').value = state.title;
  applyColor(note.color);
  showPin(note.pinned);
  render();
  refreshHints();
  if (fresh) addTask(0); // new note: one empty task focused
})();
