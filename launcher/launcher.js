const $ = (s) => document.querySelector(s);
const SCALE = 0.2; // preview is drawn at a fixed scale so sizes compare honestly
const LIMITS = { w: [200, 800], h: [160, 1000] }; // same as main.js SIZE
let color;
let size = { w: 300, h: 360 };
let mode = 'home'; // 'home' | 'setup' (new note) | 'resize' (existing note, applied live)
let editId = null, orig = null, editColor = null;

function show(view) {
  mode = view;
  $('#home').hidden = view !== 'home';
  $('#setup').hidden = view === 'home';
  $('#colorRow').hidden = view === 'resize';
  $('#create').disabled = false;
  $('#create').textContent = view === 'resize' ? 'Done' : 'Create note';
  $('#heading').textContent = { setup: 'New note', resize: 'Note size' }[view] || 'Sticky notes';
  if (view === 'setup') setSize(300, 360);
}

const clampTo = (k, v) => Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], Math.round(v) || LIMITS[k][0]));

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
  api.launcher.focus(n.id); // bring it into view without taking focus from here
}

function renderNotes(notes) {
  const ul = $('#open');
  ul.replaceChildren(...notes.map((n) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="chip"></span><span class="name"></span>';
    li.querySelector('.chip').style.background = n.color;
    li.querySelector('.name').textContent = n.title || 'Untitled';
    li.title = 'Click to change size';
    li.onclick = () => editSize(n);
    return li;
  }));
  if (!notes.length) ul.innerHTML = '<li class="empty">No notes open yet.</li>';
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

function renderArchived(list) {
  const ul = $('#archived');
  ul.replaceChildren(...list.map((z) => {
    const li = document.createElement('li');
    li.style.cursor = 'default';
    li.innerHTML = '<span class="meta"><span class="name"></span><span class="date"></span></span><button class="restore">Restore</button>';
    li.querySelector('.name').textContent = z.title;
    li.querySelector('.date').textContent = fmt(z.archivedAt);
    li.querySelector('.restore').onclick = () => api.launcher.restore(z.zip);
    return li;
  }));
  if (!list.length) ul.innerHTML = '<li class="empty">Closed notes show up here.</li>';
}

function renderState(s) {
  renderNotes(s.notes);
  renderArchived(s.archived);
  $('#reopen').disabled = !s.lastClosed;
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
  const inRange = (v) => v >= LIMITS[k][0] && v <= LIMITS[k][1];
  // typing: apply as soon as the number is valid; leaving the box / Enter: clamp whatever is there
  num.oninput = () => { if (inRange(+num.value)) setSize(k === 'w' ? +num.value : size.w, k === 'h' ? +num.value : size.h, `${k}Num`); };
  num.onchange = () => setSize(k === 'w' ? +num.value || size.w : size.w, k === 'h' ? +num.value || size.h : size.h);
}
$('#new').onclick = () => show('setup');
$('#cancel').onclick = () => {
  if (mode === 'resize') api.launcher.resize(editId, orig.w, orig.h); // undo the live changes
  show('home');
};
$('#create').onclick = () => {
  if (mode === 'resize') return show('home'); // already applied live
  $('#create').disabled = true;
  api.launcher.create({ width: size.w, height: size.h, color });
  show('home');
};
$('#close').onclick = () => window.close();
document.onkeydown = (e) => {
  if (e.key !== 'Escape') return;
  if (mode === 'home') window.close(); else $('#cancel').onclick();
};
$('#reopen').onclick = () => api.launcher.reopen();
$('#openArchive').onclick = () => api.launcher.openArchive();
api.launcher.onView(show);
api.launcher.onState(renderState);

(async () => {
  const state = await api.launcher.state();
  const { palette } = state;
  $('#swatches').replaceChildren(...palette.map((c) => {
    const b = document.createElement('button');
    Object.assign(b, { title: c.name, onclick: () => pick(c.hex) });
    b.dataset.hex = c.hex;
    b.setAttribute('role', 'radio');
    b.style.background = c.hex;
    return b;
  }));
  pick(palette[0].hex);
  renderState(state);
  show(new URLSearchParams(location.search).get('view') || 'home');
})();
