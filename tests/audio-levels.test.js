// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AudioLevelMonitor } from '../src/net/audio-levels.js';

/*
 * The monitor is handed the same stream more than once: a remote stream is
 * announced again for every track that lands in it, and the local stream
 * whenever its microphone track is swapped. Only the swap needs the
 * analyser rebuilt — a source node follows the track it was made with.
 */

class FakeAnalyser {
  fftSize = 2048;
  level = 128; // silence
  getByteTimeDomainData(data) {
    data.fill(this.level);
  }
}

let analysers;
let sources;

beforeEach(() => {
  vi.useFakeTimers();
  analysers = [];
  sources = [];
  window.AudioContext = class {
    state = 'running';
    createMediaStreamSource(stream) {
      const source = { stream, connect: vi.fn(), disconnect: vi.fn() };
      sources.push(source);
      return source;
    }
    createAnalyser() {
      const analyser = new FakeAnalyser();
      analysers.push(analyser);
      return analyser;
    }
    async resume() {}
    async close() {}
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete window.AudioContext;
});

const stream = (...tracks) => ({ getAudioTracks: () => tracks });
const track = (label) => ({ kind: 'audio', label });

describe('watching a stream', () => {
  it('keeps the detector across a re-announcement of the same track — no flicker', () => {
    const monitor = new AudioLevelMonitor();
    const events = [];
    monitor.on('speaking', (e) => events.push(e));
    const mic = track('mic');
    monitor.watch('peer', stream(mic));
    analysers[0].level = 200; // loud
    vi.advanceTimersByTime(250);
    expect(events).toEqual([{ id: 'peer', speaking: true }]);

    // The stream is announced again (a video track landed in it).
    monitor.watch('peer', stream(mic));
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(events).toEqual([{ id: 'peer', speaking: true }]); // still speaking, said once
    monitor.close();
  });

  it('rebuilds the analyser when the track itself changes', () => {
    const monitor = new AudioLevelMonitor();
    monitor.watch('me', stream(track('built-in')));
    monitor.watch('me', stream(track('headset')));
    expect(sources).toHaveLength(2);
    expect(sources[0].disconnect).toHaveBeenCalled();
    monitor.close();
  });

  it('ignores a stream with no audio in it yet', () => {
    const monitor = new AudioLevelMonitor();
    monitor.watch('peer', stream());
    expect(sources).toHaveLength(0);
    monitor.close();
  });
});
