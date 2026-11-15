const $ = (s) => document.querySelector(s);
const SCALE = 0.2; // preview is drawn at a fixed scale so sizes compare honestly
const HEADING = { home: 'Sticky notes', setup: 'New note', resize: 'Note size', history: 'History', help: 'Help' };
const KIND = { done: 'Completed', deleted: 'Deleted', note: 'Closed note' };
let limits = { w: [200, 800], h: [160, 1000] }; // replaced by the main process's limits on load
let color;
let size = { w: 300, h: 360 };
let mode = 'home'; // 'home' | 'setup' (new note) | 'resize' (existing note, applied live) | 'history' | 'help'
let editId = null, orig = null, editColor = null;
let history = [];

function show(view) {
  mode = view in HEADING ? view : 'home';
  for (const id of ['home', 'history', 'help']) $(`#${id}`).hidden = mode !== id;
  $('#setup').hidden = mode !== 'setup' && mode !== 'resize';
  $('#back').hidden = mode === 'home';
  $('#colorRow').hidden = mode === 'resize';
  $('#create').disabled = false;
  $('#create').textContent = mode === 'resize' ? 'Done' : 'Create note';
  $('#heading').textContent = HEADING[mode];
  if (mode === 'setup') setSize(300, 360);
  if (mode === 'history') { renderHistory(); $('#q').focus(); }
}
function back() {
  if (mode === 'resize') api.launcher.resize(editId, orig.w, orig.h); // undo the live changes
  show('home');
}

const clampTo = (k, v) => Math.min(limits[k][1], Math.max(limits[k][0], Math.round(v) || limits[k][0]));

// from = the control the user is typing/dragging in, so it is not overwritten mid-edit
function setSize(w, h, from) {
  size = { w: clampTo('w', w), h: clampTo('h', h) };
  for (const k of ['w', 'h']) {
    if (from !== `${k}`) $(`#${k}`).value = size[k];
    if (from !== `${k}Num`) $(`#${k}Num`).value = size[k];
  }
  preview();
  if (mode === 'resize') api.launcher.resize(editId, size.w, size.h);
}

function editSize(n) {
  editId = n.id;
  orig = { w: n.width || 300, h: n.height || 360 };
  editColor = n.color;
  show('resize');
  $('#heading').textContent = n.title || 'Untitled';
  setSize(orig.w, orig.h);
  api.launcher.focus(n.id, false); // bring it into view without taking focus from here
}

const el = (html) => { const t = document.createElement('template'); t.innerHTML = html; return t.content.firstChild; };

function renderNotes(notes) {
  $('#open').replaceChildren(...notes.map((n) => {
    const li = el('<li><button class="go" title="Show this note"><span class="chip"></span><span class="name"></span></button><button class="small">Size</button></li>');
    li.querySelector('.chip').style.background = n.color;
    li.querySelector('.name').textContent = n.title || 'Untitled';
    li.querySelector('.go').onclick = () => api.launcher.focus(n.id, true);
    li.querySelector('.small').onclick = () => editSize(n);
    return li;
  }));
  if (!notes.length) $('#open').innerHTML = '<li class="note">No notes yet. Click New note to make your first one.</li>';
}

const fmt = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const day = (ms) => new Date(ms).toLocaleDateString('sv'); // YYYY-MM-DD, local time: compares with <input type=date>

function renderHistory() {
  const q = $('#q').value.trim().toLowerCase();
  const from = $('#from').value, to = $('#to').value;
  const shown = history.filter((h) => (!q || `${h.text}\n${h.note || ''}\n${h.find || ''}`.toLowerCase().includes(q))
    && (!from || day(h.at) >= from) && (!to || day(h.at) <= to));
  $('#count').textContent = !history.length ? 'Nothing here yet. Completed tasks, deleted tasks and closed notes are kept here.'
    : !shown.length ? 'Nothing matches. Clear the search or the dates.'
      : `${shown.length} of ${history.length} item${history.length === 1 ? '' : 's'}`;
  $('#hist').replaceChildren(...shown.map((h) => {
    const li = el('<li><span class="meta"><span class="name"></span><span class="date"></span></span><button class="small restore">Restore</button><button class="small del" title="Delete permanently">Delete</button></li>');
    li.querySelector('.name').textContent = h.text;
    li.querySelector('.name').title = h.text;
    const where = h.kind === 'note' ? `${h.count} task${h.count === 1 ? '' : 's'}` : h.note || 'Untitled';
    li.querySelector('.date').textContent = `${KIND[h.kind]} · ${where} · ${fmt(h.at)}`;
    li.querySelector('.restore').title = { done: 'Untick this task', deleted: 'Put this task back on its note', note: 'Reopen this note' }[h.kind];
    li.querySelector('.restore').onclick = () => api.restore(h.id);
    li.querySelector('.del').onclick = () => api.launcher.deleteForever(h.id);
    return li;
  }));
}

function renderState(s) {
  history = s.history;
  renderNotes(s.notes);
  $('#reopen').disabled = !s.canReopen;
  if (mode === 'history') renderHistory();
}

function preview() {
  Object.assign($('#preview').style, { width: `${size.w * SCALE}px`, height: `${size.h * SCALE}px`, background: mode === 'resize' ? editColor : color });
}

function pick(hex) {
  color = hex;
  $('#swatches').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.hex === hex));
  preview();
}

$('#w').oninput = () => setSize(+$('#w').value, size.h, 'w');
$('#h').oninput = () => setSize(size.w, +$('#h').value, 'h');
for (const k of ['w', 'h']) {
  const num = $(`#${k}Num`);
  const inRange = (v) => v >= limits[k][0] && v <= limits[k][1];
  // typing: apply as soon as the number is valid; leaving the box / Enter: clamp whatever is there
  num.oninput = () => { if (inRange(+num.value)) setSize(k === 'w' ? +num.value : size.w, k === 'h' ? +num.value : size.h, `${k}Num`); };
  num.onchange = () => setSize(k === 'w' ? +num.value || size.w : size.w, k === 'h' ? +num.value || size.h : size.h);
}
for (const id of ['q', 'from', 'to']) $(`#${id}`).oninput = renderHistory;
$('#new').onclick = () => show('setup');
$('#historyBtn').onclick = () => show('history');
$('#helpBtn').onclick = () => show('help');
$('#back').onclick = back;
$('#cancel').onclick = back;
$('#create').onclick = () => {
  if (mode === 'resize') return show('home'); // already applied live
  $('#create').disabled = true;
  api.launcher.create({ width: size.w, height: size.h, color });
};
$('#close').onclick = () => window.close();
$('#reopen').onclick = () => api.launcher.reopen();
document.onkeydown = (e) => {
  const key = e.key.toLowerCase();
  if (e.key === 'Escape') { if (mode === 'home') window.close(); else back(); } else if (e.key === 'F1') show('help');
  else if (!e.ctrlKey || e.altKey || e.shiftKey) return;
  else if (key === 'n') show('setup');
  else if (key === 'f') show('history');
  else return;
  e.preventDefault();
};
api.launcher.onView(show);
api.launcher.onState(renderState);

(async () => {
  const state = await api.launcher.state();
  limits = state.limits;
  for (const k of ['w', 'h']) for (const id of [k, `${k}Num`]) Object.assign($(`#${id}`), { min: limits[k][0], max: limits[k][1] });
  $('#swatches').replaceChildren(...state.palette.map((c) => {
    const b = document.createElement('button');
    Object.assign(b, { title: c.name, onclick: () => pick(c.hex) });
    b.dataset.hex = c.hex;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c.name);
    b.style.background = c.hex;
    return b;
  }));
  pick(state.palette[0].hex);
  renderState(state);
  show(new URLSearchParams(location.search).get('view') || 'home');
})();
