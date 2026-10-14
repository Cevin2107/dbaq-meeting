import { Emitter } from './emitter.js';

/**
 * What the host knows about its own meeting link, as one line of status.
 *
 * The link is the room's entry in the directory (lib/rooms.js); the host's
 * lease writes it and reports every write. This turns those reports, and
 * the moments the invite changes, into words for the meeting info panel —
 * so a host with a guest on the phone saying "it says connecting" has
 * somewhere to look.
 *
 * States (`state`), for a host of a room:
 *  - 'working'      the last write landed: the link points at this meeting
 *  - 'refreshing'   the invite just changed, or nothing has been written yet
 *  - 'failing'      the directory could not be reached — with the advice inline
 *  - 'held'         another meeting holds this link right now
 * and null for a guest, who writes nothing.
 *
 * Emits 'change' {state, label, detail} — only when the words change, so a
 * status region fed from it is not re-announced on every heartbeat.
 */
export class LinkHealth extends Emitter {
  #host = false;
  /** Outcome of the last write: 'ok' | 'held' | 'error' | null (none yet). */
  #last = null;
  #refreshing = false; // the invite changed; the entry has yet to carry it
  #announced = ''; // the last words announced ('' — none, which is a guest's state too)

  /** Whether we host the room — only a host has a line. */
  role({ host }) {
    this.#host = !!host;
    if (!host) {
      this.#last = null;
      this.#refreshing = false;
    }
    this.#announce();
  }

  /** The invite newcomers need changed; the entry is about to be rewritten. */
  codeChanged() {
    this.#refreshing = true;
    this.#announce();
  }

  /** The lease wrote the entry (see RoomLease 'beat'). */
  beat({ ok, held = false }) {
    this.#last = ok ? 'ok' : held ? 'held' : 'error';
    if (ok) this.#refreshing = false;
    this.#announce();
  }

  get state() {
    if (!this.#host) return null;
    if (this.#last === 'held') return 'held';
    if (this.#last === 'error') return 'failing';
    if (this.#refreshing || this.#last === null) return 'refreshing';
    return 'working';
  }

  /** The line to show: {state, label, detail}, or null for a guest. */
  snapshot() {
    const state = this.state;
    if (state === null) return null;
    switch (state) {
      case 'working':
        return { state, label: 'Working', detail: 'Anyone who opens the link reaches this meeting.' };
      case 'refreshing':
        return {
          state,
          label: 'Refreshing…',
          detail: 'The link is being updated. Anyone opening it right now will be in shortly.',
        };
      case 'held':
        return {
          state,
          label: 'In use by another meeting',
          detail:
            'Someone else started a meeting on this link at the same time, and the link points at theirs. New participants will land there; this meeting carries on for everyone in it.',
        };
      default:
        return {
          state,
          label: 'Can’t be updated',
          detail:
            'The link couldn’t be updated just now. New participants may not find this meeting until it can be — if someone is stuck, ask them to reopen the link in a moment.',
        };
    }
  }

  #announce() {
    const next = this.snapshot();
    const key = next ? `${next.state}|${next.detail}` : '';
    if (key === this.#announced) return;
    this.#announced = key;
    this.emit('change', next);
  }
}
