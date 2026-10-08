import { RTC_CONFIG, loadIceServers } from './config';

// Wraps RTCPeerConnection and fixes the "ICE candidate arrives before remote description" race
// by queueing candidates until the remote description is set.
//
// relayOnly = true forces all media through the TURN server (Metered). It is used as an automatic
// fallback when a direct/STUN connection between a remote employee and the admin fails.
export async function createPeerAsync(remoteId, socket, opts = {}) {
  await loadIceServers(); // always make sure Metered TURN credentials are loaded before connecting
  return createPeer(remoteId, socket, opts);
}

export function createPeer(remoteId, socket, { onTrack, onState, relayOnly = false } = {}) {
  const pc = new RTCPeerConnection({
    ...RTC_CONFIG,
    iceTransportPolicy: relayOnly ? 'relay' : 'all',
  });
  const queue = [];
  let disconnectTimer = null;

  pc.onicecandidate = e => e.candidate && socket.emit('ice-candidate', { to: remoteId, candidate: e.candidate });
  if (onTrack) pc.ontrack = ev => {
    console.log('[webrtc]', remoteId, 'ontrack', ev.track?.kind, ev.track?.readyState, ev.streams?.length || 0);
    onTrack(ev);
  };
  pc.oniceconnectionstatechange = () => console.log('[webrtc]', remoteId, 'ICE', pc.iceConnectionState);
  pc.onicecandidateerror = e => console.warn('[webrtc]', remoteId, 'ICE candidate error', e.errorCode, e.errorText);
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    console.log('[webrtc]', remoteId, st, relayOnly ? '(relay)' : '');
    clearTimeout(disconnectTimer);
    // "disconnected" often never recovers on bad networks - treat it as failed after a few seconds.
    if (st === 'disconnected') {
      disconnectTimer = setTimeout(() => {
        if (pc.connectionState === 'disconnected') onState?.('failed');
      }, 6000);
    }
    onState?.(st);
  };

  const flush = async () => {
    while (queue.length) { try { await pc.addIceCandidate(queue.shift()); } catch { /* ignore stale candidate */ } }
  };

  return {
    pc,
    async setRemote(desc) { await pc.setRemoteDescription(desc); await flush(); },
    async addCandidate(c) {
      if (pc.remoteDescription) { try { await pc.addIceCandidate(c); } catch { /* ignore */ } }
      else queue.push(c);
    },
    close() {
      clearTimeout(disconnectTimer);
      pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = pc.oniceconnectionstatechange = pc.onicecandidateerror = null;
      pc.close();
    },
  };
}
