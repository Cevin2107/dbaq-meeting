/**
 * Silence one benign, unavoidable console error from puter.js's peer layer.
 *
 * `PuterPeerConnection` applies the SDP answer during its initial handshake
 * without awaiting or catching it — `this.setRemoteDescription(answer)`,
 * bare. When a connection is torn down before that answer lands, the browser
 * rejects the call with an uncaught `InvalidStateError` because the
 * RTCPeerConnection is already closed. Nothing is wrong: a closed connection
 * can do nothing, and we closed it on purpose. But it surfaces as
 *
 *   Uncaught (in promise) InvalidStateError: Failed to execute
 *   'setRemoteDescription' on 'RTCPeerConnection': the RTCPeerConnection's
 *   signalingState is 'closed'.
 *
 * every time — and the host self-probe tears a throwaway connection down
 * exactly this way every 15 s (src/net/session.js), so a host sees it for
 * the life of the meeting and reasonably reads it as a fault.
 *
 * We can't add the missing `.catch` inside the library, so swallow that one
 * rejection — matched narrowly on name and message — and let every other
 * unhandled rejection through untouched.
 */
export function silenceClosedPeerConnectionNoise() {
  if (typeof window === 'undefined' || window.__pmRtcNoiseSilenced) return;
  window.__pmRtcNoiseSilenced = true;
  window.addEventListener('unhandledrejection', (event) => {
    const error = event?.reason;
    if (!error || error.name !== 'InvalidStateError') return;
    const message = String(error.message ?? '');
    if (/setRemoteDescription/.test(message) && /closed/.test(message)) {
      event.preventDefault(); // benign: the connection was already torn down
    }
  });
}
