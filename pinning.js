// Pinned = stuck to the desktop (Windows only, via koffi; elsewhere it is just a normal locked window):
//  - the window is owned by the desktop window "Progman" (survives Win+D, like Rainmeter's "On Desktop")
//  - WM_WINDOWPOSCHANGING is intercepted so activation never lifts it above other apps
// Unpinned = always on top, movable, resizable.
const WIN = process.platform === 'win32';
let api = null;
if (WIN) {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  api = {
    FindWindowW: user32.func('intptr_t __stdcall FindWindowW(str16 cls, str16 name)'),
    SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int idx, intptr_t value)'),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
    peek: kernel32.func('void __stdcall RtlMoveMemory(_Out_ uint8_t *dst, uintptr_t src, size_t n)'),
    poke: kernel32.func('void __stdcall RtlMoveMemory(uintptr_t dst, const uint8_t *src, size_t n)'),
  };
}

const WM_WINDOWPOSCHANGING = 0x0046;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
const HWND_BOTTOM = 1, GWLP_HWNDPARENT = -8;
const FLAGS_OFFSET = 32; // WINDOWPOS on x64: hwnd(8) insertAfter(8) x y cx cy(16) flags(4)

const locked = new WeakSet();
const raiseTimers = new WeakMap();
const hwnd = (win) => win.getNativeWindowHandle().readBigUInt64LE(0);

function toBottom(win) {
  api.SetWindowPos(hwnd(win), HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
}

function setup(win) {
  if (!WIN) return;
  win.hookWindowMessage(WM_WINDOWPOSCHANGING, (_wParam, lParam) => {
    if (!locked.has(win)) return;
    const addr = lParam.readBigUInt64LE(0);
    const pos = Buffer.alloc(40);
    api.peek(pos, addr, 40);
    const flags = pos.readUInt32LE(FLAGS_OFFSET);
    if (flags & SWP_NOZORDER || pos.readBigInt64LE(8) === BigInt(HWND_BOTTOM)) return;
    pos.writeUInt32LE(flags | SWP_NOZORDER, FLAGS_OFFSET); // keep the z-order: clicking must not raise it
    api.poke(addr + BigInt(FLAGS_OFFSET), pos.subarray(FLAGS_OFFSET, FLAGS_OFFSET + 4), 4);
  });
}

function apply(win, pinned) {
  clearTimeout(raiseTimers.get(win));
  win.setMovable(!pinned);
  win.setResizable(!pinned);
  if (!pinned) {
    locked.delete(win);
    if (WIN) api.SetWindowLongPtrW(hwnd(win), GWLP_HWNDPARENT, 0);
    win.setAlwaysOnTop(true);
    return;
  }
  win.setAlwaysOnTop(false); // before locking: dropping topmost is itself a z-order change
  if (!WIN) return;
  api.SetWindowLongPtrW(hwnd(win), GWLP_HWNDPARENT, api.FindWindowW('Progman', null));
  toBottom(win);
  locked.add(win);
}

// Lift a pinned note above everything for a moment (tray click), then send it back to the desktop.
function raise(win, ms, stillPinned) {
  locked.delete(win);
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  clearTimeout(raiseTimers.get(win));
  raiseTimers.set(win, setTimeout(() => {
    if (!win.isDestroyed() && stillPinned()) apply(win, true);
  }, ms));
}

module.exports = { setup, apply, raise };
