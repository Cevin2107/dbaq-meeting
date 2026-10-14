import { Emitter } from './emitter.js';

/**
 * @typedef {Object} Participant
 * @property {string} id
 * @property {string} name
 * @property {boolean} isSelf
 * @property {boolean} mic          microphone on
 * @property {boolean} cam          camera on
 * @property {boolean} hand         hand raised
 * @property {boolean} presenting   sharing screen
 * @property {boolean} speaking
 * @property {boolean} reconnecting  our link to them died and is being rebuilt
 * @property {number}  joinedAt
 */

/**
 * The set of meeting participants, ordered by join time (self first).
 * Emits: 'add', 'update', 'remove', 'change' (any of the above).
 */
export class Roster extends Emitter {
  /** @type {Map<string, Participant>} */
  #byId = new Map();

  add({ id, name, isSelf = false, mic = false, cam = false, hand = false, presenting = false, joinedAt }) {
    if (this.#byId.has(id)) return this.update(id, { name, mic, cam, hand, presenting });
    const participant = {
      id,
      name,
      isSelf,
      mic,
      cam,
      hand,
      presenting,
      speaking: false,
      reconnecting: false,
      joinedAt: joinedAt ?? Date.now(),
    };
    this.#byId.set(id, participant);
    this.emit('add', participant);
    this.emit('change', { type: 'add', participant });
    return participant;
  }

  /**
   * Patch a participant. Returns the participant, or null if unknown.
   * Emits 'update' only when something actually changed.
   */
  update(id, patch) {
    const p = this.#byId.get(id);
    if (!p) return null;
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || Object.is(p[key], value)) continue;
      p[key] = value;
      changed = true;
    }
    if (changed) {
      this.emit('update', p);
      this.emit('change', { type: 'update', participant: p });
    }
    return p;
  }

  remove(id) {
    const p = this.#byId.get(id);
    if (!p) return null;
    this.#byId.delete(id);
    this.emit('remove', p);
    this.emit('change', { type: 'remove', participant: p });
    return p;
  }

  get(id) {
    return this.#byId.get(id) ?? null;
  }

  has(id) {
    return this.#byId.has(id);
  }

  get size() {
    return this.#byId.size;
  }

  /** Everyone, self first, then by join time. */
  sorted() {
    return [...this.#byId.values()].sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return a.joinedAt - b.joinedAt || a.id.localeCompare(b.id);
    });
  }

  /** Everyone except self. */
  others() {
    return this.sorted().filter((p) => !p.isSelf);
  }

  self() {
    return [...this.#byId.values()].find((p) => p.isSelf) ?? null;
  }

  /** Participants with raised hands, by when they joined. */
  raisedHands() {
    return this.sorted().filter((p) => p.hand);
  }

  clear() {
    for (const id of [...this.#byId.keys()]) this.remove(id);
  }
}
