// History rules as plain functions on the data: no windows, no disk, so they can be tested.
// History shows three things: stored entries (deleted tasks, closed notes) and, read live from the
// open notes, their completed tasks. A live task is addressed as "done:<noteId>:<taskId>" (or "open:" in search).
const { newId, makeNote } = require('./model');

const liveNote = (data, id) => data.notes.find((n) => n.id === id);
const liveRef = (data, id) => {
  const [, noteId, taskId] = /^(?:done|open):([^:]+):(.+)$/.exec(id) || [];
  const note = liveNote(data, noteId);
  const task = note?.tasks.find((t) => t.id === taskId);
  return task ? { note, task } : null;
};

// Move a task from its note to History. Returns the entry id (for Undo), or null for an empty row.
function deleteTask(data, note, taskId) {
  const index = note.tasks.findIndex((t) => t.id === taskId);
  if (index < 0) return null;
  const [task] = note.tasks.splice(index, 1);
  if (!task.text) return null;
  const entry = { id: newId(), kind: 'task', at: Date.now(), noteId: note.id, noteTitle: note.title, index, task };
  data.history.push(entry);
  return entry.id;
}

// Move every completed task of a note to History. Restoring the returned ids in order rebuilds the list:
// tasks are taken from the end, so each stored index is the task's place in the original list.
function clearDone(data, note) {
  const ids = [];
  for (let i = note.tasks.length - 1; i >= 0; i--) {
    if (note.tasks[i].done) ids.unshift(deleteTask(data, note, note.tasks[i].id));
  }
  return ids.filter(Boolean);
}

// An empty note is just dropped; anything else is kept in History.
function closeNote(data, note) {
  if (!data.notes.includes(note)) return false;
  data.notes = data.notes.filter((n) => n !== note);
  if (note.title || note.tasks.some((t) => t.text)) data.history.push({ id: newId(), kind: 'note', at: Date.now(), note });
  return true;
}

// Rows for the History view, newest first, then (for search only) the open tasks.
function items(data) {
  const live = (kind) => data.notes.flatMap((n) => n.tasks.filter((t) => t.text && t.done === (kind === 'done'))
    .map((t) => ({ id: `${kind}:${n.id}:${t.id}`, kind, at: t.doneAt || 0, text: t.text, note: n.title, noteId: n.id })));
  return [
    ...[...data.history.map((e) => (e.kind === 'note'
      ? { id: e.id, kind: 'note', stored: true, at: e.at, text: e.note.title || 'Untitled', find: e.note.tasks.map((t) => t.text).join('\n'), count: e.note.tasks.length }
      : { id: e.id, kind: e.task.done ? 'done' : 'deleted', stored: true, at: e.at, text: e.task.text, note: e.noteTitle })),
    ...live('done')].sort((a, b) => b.at - a.at),
    ...live('open'),
  ];
}

const lastClosed = (data) => data.history.filter((e) => e.kind === 'note').sort((a, b) => b.at - a.at)[0];

// Put something back. Returns null if the id is unknown, else what the caller has to show:
//   open:  notes that need a window now (a reopened or newly made note)
//   sync:  { noteId, op } for a note window that is already open
//   focus: the note the item ended up on
function restore(data, id) {
  const live = liveRef(data, id);
  if (live) { // a completed task on an open note: untick it
    live.task.done = false;
    delete live.task.doneAt;
    return { open: [], sync: { noteId: live.note.id, op: { op: 'upsert', task: live.task } }, focus: live.note.id };
  }
  const k = data.history.findIndex((e) => e.id === id);
  if (k < 0) return null;
  const [e] = data.history.splice(k, 1);
  if (e.kind === 'note') {
    if (liveNote(data, e.note.id)) e.note.id = newId();
    data.notes.push(e.note);
    return { open: [e.note], sync: null, focus: e.note.id };
  }
  // a task goes back onto its note; a closed note is reopened for it, and if the note is gone for good a new one is made
  const open = [];
  let note = liveNote(data, e.noteId);
  if (!note) {
    const c = data.history.findIndex((h) => h.kind === 'note' && h.note.id === e.noteId);
    note = c >= 0 ? data.history.splice(c, 1)[0].note : makeNote({ title: e.noteTitle });
    data.notes.push(note);
    open.push(note);
  }
  const index = Math.min(e.index, note.tasks.length);
  note.tasks.splice(index, 0, e.task);
  return { open, sync: { noteId: note.id, op: { op: 'upsert', task: e.task, index } }, focus: note.id };
}

// What the ids stand for, without changing anything: { names, tasks, notes } for the confirmation.
function describe(data, ids) {
  const out = { names: [], tasks: [], notes: 0 };
  for (const id of ids) {
    const live = liveRef(data, id);
    const e = live ? null : data.history.find((h) => h.id === id);
    if (live) { out.names.push(live.task.text); out.tasks.push(live.task); }
    else if (e?.kind === 'note') { out.names.push(e.note.title || 'Untitled'); out.tasks.push(...e.note.tasks); out.notes++; }
    else if (e) { out.names.push(e.task.text); out.tasks.push(e.task); }
  }
  return out;
}

// Delete for good. Returns { tasks: their .txt files can go, syncs: updates for open note windows }.
function forget(data, ids) {
  const tasks = [], syncs = [];
  for (const id of ids) {
    const live = liveRef(data, id);
    if (live) {
      live.note.tasks = live.note.tasks.filter((t) => t !== live.task);
      tasks.push(live.task);
      syncs.push({ noteId: live.note.id, op: { op: 'remove', id: live.task.id } });
      continue;
    }
    const e = data.history.find((h) => h.id === id);
    if (!e) continue;
    data.history = data.history.filter((h) => h !== e);
    tasks.push(...(e.kind === 'note' ? e.note.tasks : [e.task]));
  }
  return { tasks, syncs };
}

module.exports = { deleteTask, clearDone, closeNote, items, lastClosed, restore, describe, forget };
