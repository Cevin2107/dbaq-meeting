/**
 * Speaking detection with hysteresis (pure logic).
 *
 * A participant becomes "speaking" once their level exceeds `onThreshold`,
 * and stops only after staying below `offThreshold` for `holdMs` — which
 * avoids flicker between words.
 */
export class SpeakingDetector {
  #speaking = false;
  #belowSince = null;

  constructor({ onThreshold = 0.02, offThreshold = 0.01, holdMs = 900 } = {}) {
    this.onThreshold = onThreshold;
    this.offThreshold = offThreshold;
    this.holdMs = holdMs;
  }

  get speaking() {
    return this.#speaking;
  }

  /**
   * Feed a level sample (0..1 RMS). Returns the current speaking state.
   * @param {number} level
   * @param {number} now  timestamp in ms
   */
  update(level, now = Date.now()) {
    if (level >= this.onThreshold) {
      this.#speaking = true;
      this.#belowSince = null;
    } else if (this.#speaking && level < this.offThreshold) {
      if (this.#belowSince === null) this.#belowSince = now;
      if (now - this.#belowSince >= this.holdMs) {
        this.#speaking = false;
        this.#belowSince = null;
      }
    } else {
      // Between thresholds: keep current state, reset the off timer.
      this.#belowSince = null;
    }
    return this.#speaking;
  }

  reset() {
    this.#speaking = false;
    this.#belowSince = null;
  }
}
