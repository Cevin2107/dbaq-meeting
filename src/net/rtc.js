/**
 * Outgoing camera profile for a call with `peerCount` other participants.
 *
 * In a mesh, upload cost is (bitrate × peers) — unconstrained 720p to
 * several peers saturates typical uplinks, which shows up as periodic
 * multi-second freezes while the decoder waits out packet loss. Capping
 * bitrate (and letting the encoder drop resolution before framerate)
 * keeps motion smooth at every call size.
 *
 * Mesh economics are ours, not the SDK's: puter.peer applies whatever
 * limits we hand it and re-applies them after every renegotiation.
 */
export function cameraSendProfile(peerCount) {
  if (peerCount <= 1) {
    return { maxBitrate: 1_200_000, maxFramerate: 30, scaleResolutionDownBy: 1, degradationPreference: 'maintain-framerate' };
  }
  if (peerCount <= 3) {
    return { maxBitrate: 700_000, maxFramerate: 24, scaleResolutionDownBy: 1.5, degradationPreference: 'maintain-framerate' };
  }
  if (peerCount <= 6) {
    return { maxBitrate: 400_000, maxFramerate: 20, scaleResolutionDownBy: 2, degradationPreference: 'maintain-framerate' };
  }
  return { maxBitrate: 250_000, maxFramerate: 15, scaleResolutionDownBy: 2, degradationPreference: 'maintain-framerate' };
}

/**
 * Screen-share profile: resolution (text sharpness) matters more than
 * framerate, and there's rarely more than one presenter at a time.
 */
export const SCREEN_SEND_PROFILE = Object.freeze({
  maxBitrate: 2_500_000,
  maxFramerate: 15,
  scaleResolutionDownBy: 1,
  degradationPreference: 'maintain-resolution',
});

/**
 * How long puter.peer spends rescuing a link in place (ICE restarts) before
 * closing it, counted from the link's first sign of trouble. Handed to the
 * SDK as `recoveryTimeout` on every serve() and connect().
 *
 * Kept well inside LINK_DROP_MS: a link that cannot be rescued in place is
 * rebuilt by the guest dialing the host again, and that redial has to fit
 * in what is left before the host gives the guest up.
 */
export const LINK_RECOVERY_BUDGET_MS = 30_000;

/**
 * How long after a link first shows trouble a participant we still cannot
 * reach is dropped from the meeting. Browsers notice a dead network about
 * five seconds after it goes, so this lands a minute after it does.
 */
export const LINK_DROP_MS = 55_000;
