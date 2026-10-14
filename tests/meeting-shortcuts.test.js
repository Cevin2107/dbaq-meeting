// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountMeeting, isTextEntry } from '../src/ui/meeting.js';
import { Emitter } from '../src/lib/emitter.js';
import { Roster } from '../src/lib/roster.js';

/*
 * ⌘/Ctrl+D and ⌘/Ctrl+E toggle the microphone and camera. Ctrl+D and
 * Ctrl+E are also macOS text-editing bindings (delete-forward and
 * end-of-line), so the meeting has to leave them alone while the reader
 * is editing text — the chat composer being the one that matters.
 */

class FakeMedia extends Emitter {
  micOn = true;
  camOn = true;
  presenting = false;
  screenStream = null;
  background = { type: 'none' };
  noiseSuppression = false;
  stream = { id: 'self-stream', getAudioTracks: () => [], getVideoTracks: () => [] };
  setMicOn = vi.fn((on) => {
    this.micOn = on;
  });
  setCamOn = vi.fn((on) => {
    this.camOn = on;
  });
  listDevices = async () => ({ mics: [], cams: [], speakers: [] });
}

class FakeSession extends Emitter {
  name = 'Ada';
  setName = vi.fn((name) => {
    this.name = name;
    this.roster.update(this.selfId, { name });
  });
  selfId = 'self';
  code = 'abc-defg-hij';
  isHost = false;
  hand = false;
  startedAt = Date.now();
  roster = new Roster();
  constructor() {
    super();
    this.roster.add({ id: this.selfId, name: 'Ada', isSelf: true, mic: true, cam: true });
  }
  getStream = () => null;
  sendChat = vi.fn();
  sendReaction = vi.fn();
  setHand = vi.fn();
}

let media;
let session;
let root;
let unmount;

/** The chat composer, reached the way a user reaches it. */
function openChatInput() {
  root.querySelector('.meeting-side-controls .bar-btn:last-child').click();
  return root.querySelector('.chat-input-row input');
}

const moreButton = () => [...root.querySelectorAll('.meeting-controls .bar-btn')].find(
  (b) => b.getAttribute('aria-haspopup') === 'menu'
);
const reactButton = () => [...root.querySelectorAll('.meeting-controls .bar-btn')].find(
  (b) => b.getAttribute('aria-label') === 'Send a reaction'
);
const menuItems = () => [...root.querySelectorAll('.menu-above-bar .menu-item')];
const reactionButtons = () => [...root.querySelectorAll('.reactions-bar button')];

function press(key, { ctrl = false, meta = false } = {}) {
  window.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, ctrlKey: ctrl, metaKey: meta, bubbles: true, cancelable: true })
  );
}

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  // jsdom's play() is a "not implemented" stub that returns undefined.
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);

  media = new FakeMedia();
  session = new FakeSession();
  root = document.createElement('div');
  document.body.append(root);
  unmount = mountMeeting(root, { media, session, roomCode: 'abc-defg-hij' }, { endCall: vi.fn() });
});

afterEach(() => {
  unmount?.();
  root.remove();
});

describe('meeting keyboard shortcuts', () => {
  it('saves a new nickname from Settings and updates the live tile', () => {
    moreButton().click();
    menuItems().find((item) => item.textContent === 'Settings').click();
    const input = document.querySelector('[aria-label="Nickname"]');
    expect(input.value).toBe('Ada');
    input.value = 'Grace';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.nickname-form button[type="submit"]').click();
    expect(session.setName).toHaveBeenCalledWith('Grace');
    expect(root.querySelector('.tile-name').textContent).toContain('Grace');
    expect(JSON.parse(localStorage.getItem('pm.name'))).toBe('Grace');
    localStorage.removeItem('pm.name');
  });

  it('toggles the microphone with Ctrl+D outside a text field', () => {
    press('d', { ctrl: true });
    expect(media.setMicOn).toHaveBeenCalledWith(false);
  });

  it('toggles the camera with Cmd+E outside a text field', () => {
    press('e', { meta: true });
    expect(media.setCamOn).toHaveBeenCalledWith(false);
  });

  it('leaves Ctrl+D to the chat composer, which uses it to delete forward', () => {
    const input = openChatInput();
    input.focus();
    expect(document.activeElement).toBe(input);

    press('d', { ctrl: true });
    expect(media.setMicOn).not.toHaveBeenCalled();
  });

  it('leaves Ctrl+E to the chat composer, which uses it to jump to end of line', () => {
    const input = openChatInput();
    input.focus();

    press('e', { ctrl: true });
    expect(media.setCamOn).not.toHaveBeenCalled();
  });

  it('does not swallow the keystroke it declines to act on', () => {
    const input = openChatInput();
    input.focus();

    const event = new window.KeyboardEvent('keydown', {
      key: 'd',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('still works once focus leaves the composer', () => {
    const input = openChatInput();
    input.focus();
    input.blur();

    press('d', { ctrl: true });
    expect(media.setMicOn).toHaveBeenCalledWith(false);
  });
});

describe('isTextEntry', () => {
  const node = (html) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    return wrap.firstElementChild;
  };

  it('recognizes a caret the user is editing', () => {
    expect(isTextEntry(node('<input type="text">'))).toBe(true);
    expect(isTextEntry(node('<input>'))).toBe(true); // type defaults to text
    expect(isTextEntry(node('<textarea></textarea>'))).toBe(true);
  });

  it('recognizes a contenteditable host', () => {
    // jsdom leaves isContentEditable unimplemented, so stand it up before
    // asking — the point under test is that we consult it at all.
    const div = node('<div contenteditable="true"></div>');
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isTextEntry(div)).toBe(true);
  });

  it('leaves controls that only hold focus alone', () => {
    expect(isTextEntry(node('<button>go</button>'))).toBe(false);
    expect(isTextEntry(node('<select><option>a</option></select>'))).toBe(false);
    expect(isTextEntry(node('<input type="checkbox">'))).toBe(false);
    expect(isTextEntry(node('<input type="range">'))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});


describe('meeting popover keyboard access', () => {
  it('takes focus into the More menu, which role=menu promises', () => {
    moreButton().click();
    expect(menuItems().length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(menuItems()[0]);
    expect(moreButton().getAttribute('aria-expanded')).toBe('true');
  });

  it('walks the More menu with the arrow keys, wrapping at both ends', () => {
    moreButton().click();
    const items = menuItems();

    press('ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    press('ArrowUp');
    expect(document.activeElement).toBe(items[0]);
    press('ArrowUp'); // wraps to the last
    expect(document.activeElement).toBe(items[items.length - 1]);
    press('ArrowDown'); // and back round to the first
    expect(document.activeElement).toBe(items[0]);
  });

  it('hands focus back to the trigger when the More menu closes', () => {
    moreButton().click();
    press('Escape');
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(moreButton());
    expect(moreButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('takes focus into the reactions toolbar, and keeps it to one tab stop', () => {
    reactButton().click();
    const buttons = reactionButtons();
    expect(buttons.length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
  });

  it('walks the reactions toolbar with the arrow keys, tab stop in tow', () => {
    reactButton().click();
    const buttons = reactionButtons();

    press('ArrowRight');
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([buttons[1]]);

    press('ArrowLeft');
    press('ArrowLeft'); // wraps to the last
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('hands focus back to the trigger when the reactions toolbar closes', () => {
    reactButton().click();
    press('Escape');
    expect(reactionButtons()).toHaveLength(0);
    expect(document.activeElement).toBe(reactButton());
  });

  it('leaves the arrow keys alone once focus has left the popover', () => {
    reactButton().click();
    const input = openChatInput();
    input.focus(); // the toolbar is still open behind the panel

    const event = new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    // The caret keeps its key, and focus stays in the message being typed.
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('does not chase focus onto a control the teardown is about to drop', () => {
    moreButton().click();
    const trigger = moreButton();
    unmount();
    unmount = null;
    // The menu is gone, and focus was left where the removal put it rather
    // than being handed to a button the caller is about to clear away.
    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).not.toBe(trigger);
  });
});
