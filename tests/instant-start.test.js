// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/*
 * "Start an instant meeting" puts a user the app already knows — signed
 * in, name remembered from an earlier join — straight into the call, and
 * shows the green room to everyone else. The report: "Start instant
 * meeting should immediately drop me into the call; at least if my name is
 * already saved once so that you don't have to ask for it".
 */

/** Enough of MediaStream for LocalMedia to construct in jsdom. */
class FakeMediaStream {
  #tracks = [];
  id = 'stream-1';
  getTracks() {
    return this.#tracks;
  }
  getAudioTracks() {
    return [];
  }
  getVideoTracks() {
    return [];
  }
  addTrack() {}
  removeTrack() {}
}

// Shared with the module mocks below, which are hoisted above the imports.
const world = vi.hoisted(() => ({
  hosted: /** @type {string[]} */ ([]),
  /** @type {() => Promise<void>} what RoomSession.host awaits */
  host: async () => {},
  /** @type {() => Promise<{ok: boolean}>} what RoomLease.start answers */
  lease: async () => ({ ok: true }),
  /** @type {import('vitest').Mock} */
  mountMeeting: null,
}));

vi.mock('../src/net/session.js', async (importOriginal) => {
  const real = await importOriginal();
  class FakeSession {
    isHost = true;
    peerCount = 0;
    code = 'invite-1';
    selfId = 'self';
    constructor({ name, secret = null }) {
      this.name = name;
      this.meetingSecret = secret;
    }
    on() {
      return () => {};
    }
    async host() {
      world.hosted.push(this.name);
      await world.host();
    }
    leave() {}
    getStream() {
      return null;
    }
  }
  return { ...real, RoomSession: FakeSession };
});

vi.mock('../src/lib/rooms.js', async (importOriginal) => {
  const real = await importOriginal();
  class FakeLease {
    last = null;
    constructor(code) {
      this.code = code;
    }
    async start() {
      const result = await world.lease();
      this.last = result.ok ? 'ok' : 'error';
      return result;
    }
    stop() {}
    async end() {}
    async refresh() {}
    endOnUnload() {}
    on() {
      return () => {};
    }
  }
  return { ...real, RoomLease: FakeLease };
});

vi.mock('../src/ui/meeting.js', () => ({
  mountMeeting: (...args) => world.mountMeeting(...args),
}));

function fakePuter({ signedIn = true } = {}) {
  return {
    auth: {
      isSignedIn: () => signedIn,
      getUser: async () => ({ username: 'ada-42' }),
      signIn: async () => {},
    },
    kv: {
      get: async () => null,
      set: async () => true,
      del: async () => true,
    },
  };
}

let prefs;
let app;
let toasts;
/** window listeners the app under test registered — removed after it, or every past instance would keep routing. */
let windowListeners = [];
const realAddEventListener = window.addEventListener.bind(window);

const newMeetingBtn = () => app.querySelector('.home-new .btn-primary');
const startInstantItem = () => app.querySelector('.home-new-menu .menu-item');
const greenRoom = () => app.querySelector('.prejoin-error');

beforeEach(async () => {
  localStorage.clear();
  delete window.puter;
  globalThis.MediaStream = FakeMediaStream;
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: () => Promise.reject(new Error('no devices in jsdom')),
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
    configurable: true,
  });
  world.hosted.length = 0;
  world.host = async () => {};
  world.lease = async () => ({ ok: true });
  world.mountMeeting = vi.fn(() => () => {});

  // A fresh page for a fresh module graph: main.js mounts into #app on
  // import, and prefs.js memoizes its cloud pull.
  document.body.innerHTML = '<div id="app"></div><div id="toasts"></div>';
  app = document.getElementById('app');
  toasts = document.getElementById('toasts');
  history.replaceState(null, '', location.pathname);
  window.addEventListener = (type, fn, opts) => {
    windowListeners.push([type, fn, opts]);
    realAddEventListener(type, fn, opts);
  };
  vi.resetModules();
});

afterEach(() => {
  for (const [type, fn, opts] of windowListeners) window.removeEventListener(type, fn, opts);
  windowListeners = [];
  window.addEventListener = realAddEventListener;
  history.replaceState(null, '', location.pathname);
});

/** Load the app (home screen) with the given sign-in state and saved name. */
async function boot({ signedIn = true, savedName = 'Ada Lovelace' } = {}) {
  window.puter = fakePuter({ signedIn });
  prefs = await import('../src/lib/prefs.js');
  if (savedName) prefs.setLocalPref('name', savedName);
  await import('../src/main.js');
  expect(newMeetingBtn()).not.toBeNull();
}

function clickStartInstant() {
  newMeetingBtn().click();
  startInstantItem().click();
}

describe('Start an instant meeting', () => {
  it('drops a signed-in user with a remembered name straight into the call', async () => {
    await boot();
    clickStartInstant();

    await vi.waitFor(() => expect(world.mountMeeting).toHaveBeenCalled());
    expect(greenRoom()).toBeNull();
    expect(world.hosted).toEqual(['Ada Lovelace']);
    const [, call] = world.mountMeeting.mock.calls[0];
    expect(call.roomCode).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    expect(call.session.name).toBe('Ada Lovelace');
    expect(call.media.stream).toBeInstanceOf(FakeMediaStream);
    expect(location.hash).toBe(`#/m/${call.roomCode}`);
  });

  it('says so, and takes no second click, while the meeting is on its way', async () => {
    let up;
    world.host = () => new Promise((resolve) => (up = resolve));
    await boot();
    clickStartInstant();

    await vi.waitFor(() => expect(world.hosted).toEqual(['Ada Lovelace']));
    expect(newMeetingBtn().disabled).toBe(true);
    expect(newMeetingBtn().textContent).toContain('Starting…');
    newMeetingBtn().click(); // does nothing — no menu opens
    expect(startInstantItem()).toBeNull();

    up();
    await vi.waitFor(() => expect(world.mountMeeting).toHaveBeenCalledTimes(1));
    expect(world.hosted).toHaveLength(1);
  });

  it('shows the green room the first time, so the name gets chosen there', async () => {
    await boot({ savedName: null });
    clickStartInstant();

    await vi.waitFor(() => expect(greenRoom()).not.toBeNull());
    expect(world.mountMeeting).not.toHaveBeenCalled();
    expect(world.hosted).toEqual([]);
  });

  it('shows the green room to a signed-out visitor, remembered name or not', async () => {
    await boot({ signedIn: false });
    clickStartInstant();

    await vi.waitFor(() => expect(greenRoom()).not.toBeNull());
    expect(world.mountMeeting).not.toHaveBeenCalled();
    expect(world.hosted).toEqual([]);
  });

  it('reports a start that failed and stays on the home screen, ready for another go', async () => {
    world.host = async () => {
      throw new Error('Can’t reach Puter’s connection service.');
    };
    await boot();
    clickStartInstant();

    await vi.waitFor(() => expect(toasts.textContent).toContain('Can’t reach Puter’s connection service.'));
    expect(world.mountMeeting).not.toHaveBeenCalled();
    expect(greenRoom()).toBeNull();
    expect(newMeetingBtn().disabled).toBe(false);
    expect(newMeetingBtn().textContent).toContain('New meeting');
  });

  it('still starts, on a one-time link, when the room directory is out of reach', async () => {
    world.lease = async () => {
      throw new TypeError('Failed to fetch');
    };
    await boot();
    clickStartInstant();

    await vi.waitFor(() => expect(world.mountMeeting).toHaveBeenCalled());
    const [, call] = world.mountMeeting.mock.calls[0];
    expect(call.roomCode).toBeNull();
    expect(call.lease).toBeNull();
    expect(toasts.textContent).toContain('one-time link');
  });
});
