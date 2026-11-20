import React, { useEffect, useRef, useState } from 'react';
import { socket, useConnected } from './socket';
import { createPeerAsync } from './rtc';
import { fmtDuration } from './utils';
import { FACE_API_URL, SERVER_URL, faceFetch, loadServerConfig, getAttendanceMode } from './config';

export default function Employee({ onBack }) {
  const [joined, setJoined] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [viewers, setViewers] = useState([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [attendance, setAttendance] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [lunch, setLunch] = useState(false);
  const [breakElapsed, setBreakElapsed] = useState(0);
  const [faceBusy, setFaceBusy] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const connected = useConnected();
  const [mode, setMode] = useState(getAttendanceMode());
  const [empName, setEmpName] = useState(() => localStorage.getItem('wfh-emp-name') || '');
  const [empId, setEmpId] = useState(() => localStorage.getItem('wfh-emp-id') || '');
  useEffect(() => { loadServerConfig().then(() => setMode(getAttendanceMode())); }, []);

  const stream = useRef(null);
  const cameraStream = useRef(null);
  const peers = useRef({});
  const joinedRef = useRef(false);
  const startedAt = useRef(0);
  const accumulated = useRef(0);
  const lunchStartedAt = useRef(0);
  const breakAccumulated = useRef(0);
  const lunchRef = useRef(false);
  const nameRef = useRef('Face Employee');

  const closePeer = id => { peers.current[id]?.close(); delete peers.current[id]; };
  const closeAllPeers = () => Object.keys(peers.current).forEach(closePeer);

  const doJoin = () => new Promise(resolve =>
    socket.emit('join', { role: 'employee', name: nameRef.current }, res => {
      if (res?.ok) { joinedRef.current = true; setJoined(true); }
      resolve(!!res?.ok);
    })
  );

  useEffect(() => {
    const onWatch = async ({ adminId, relay }) => {
      if (!stream.current) return;
      closePeer(adminId);
      try {
        const peer = await createPeerAsync(adminId, socket, { relayOnly: !!relay });
        if (!stream.current) { peer.close(); return; }
        peers.current[adminId] = peer;
        stream.current.getTracks().forEach(t => peer.pc.addTrack(t, stream.current));
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        socket.emit('webrtc-offer', { to: adminId, offer: peer.pc.localDescription || offer });
      } catch (err) {
        console.error('[webrtc] employee offer failed', adminId, err);
        delete peers.current[adminId];
      }
    };
    const onAnswer = ({ from, answer }) => peers.current[from]?.setRemote(answer).catch(() => {});
    const onIce = ({ from, candidate }) => peers.current[from]?.addCandidate(candidate);
    const onUnwatch = ({ adminId }) => closePeer(adminId);
    const onViewers = list => setViewers(list);
    // Server is the source of truth for today's totals: keeps the timer when sharing is stopped/restarted or the page reconnects.
    const onTotals = ({ workMs = 0, breakMs = 0 } = {}) => {
      accumulated.current = workMs;
      breakAccumulated.current = breakMs;
      if (startedAt.current) startedAt.current = Date.now();
      if (lunchStartedAt.current) lunchStartedAt.current = Date.now();
      setElapsed(workMs);
      setBreakElapsed(breakMs);
    };
    const onConnect = async () => {
      if (!joinedRef.current) return;
      if (await doJoin() && stream.current) {
        socket.emit('sharing-status', { sharing: true, lunch: lunchRef.current });
      }
    };

    socket.on('watch-request', onWatch);
    socket.on('webrtc-answer', onAnswer);
    socket.on('ice-candidate', onIce);
    socket.on('unwatch', onUnwatch);
    socket.on('viewers', onViewers);
    socket.on('connect', onConnect);
    socket.on('session-totals', onTotals);

    return () => {
      socket.off('watch-request', onWatch);
      socket.off('webrtc-answer', onAnswer);
      socket.off('ice-candidate', onIce);
      socket.off('unwatch', onUnwatch);
      socket.off('viewers', onViewers);
      socket.off('connect', onConnect);
      socket.off('session-totals', onTotals);
      closeAllPeers();
      stream.current?.getTracks().forEach(t => t.stop());
      cameraStream.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  useEffect(() => {
    const tick = setInterval(() => {
      if (sharing && !lunch && startedAt.current) {
        setElapsed(accumulated.current + (Date.now() - startedAt.current));
      }
      if (sharing && lunch && lunchStartedAt.current) {
        setBreakElapsed(breakAccumulated.current + (Date.now() - lunchStartedAt.current));
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [sharing, lunch]);

  const captureCamera = () => {
    const video = document.getElementById('face-cam');
    if (!video?.videoWidth || !video?.videoHeight) throw new Error('Face camera is not ready. Please wait a moment.');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  };

  const stopCamera = () => {
    cameraStream.current?.getTracks().forEach(t => t.stop());
    cameraStream.current = null;
  };

  const markFaceAttendance = async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API is not available in this browser.');
    cameraStream.current = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const cam = document.getElementById('face-cam');
    if (cam) {
      cam.srcObject = cameraStream.current;
      await cam.play();
    }
    await new Promise(r => setTimeout(r, 500));
    const image = captureCamera();

    const r = await faceFetch(`${FACE_API_URL}/api/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || 'Face attendance failed.');
    setAttendance(d);
    stopCamera();
    return d;
  };

  // Asks the browser for the screen. Must be called straight from a click (user gesture).
  const getScreenStream = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error(window.isSecureContext
        ? 'This browser does not support screen sharing. Use Chrome or Edge.'
        : 'Screen sharing needs HTTPS (or localhost).');
    }
    return navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor', frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,
    });
  };

  // Starts live sharing: from this moment the admin can see the screen.
  const activateShare = s => {
    stream.current = s;
    if (!startedAt.current) startedAt.current = Date.now();
    setSharing(true);
    socket.emit('sharing-status', { sharing: true, lunch: false });
    s.getVideoTracks()[0].addEventListener('ended', stop);
  };

  const markSimpleAttendance = async () => {
    const name = empName.trim();
    if (!name) throw new Error('Pehle apna naam likho.');
    const r = await fetch(`${SERVER_URL}/api/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, employeeId: empId.trim() }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || 'Attendance failed.');
    localStorage.setItem('wfh-emp-name', name);
    localStorage.setItem('wfh-emp-id', empId.trim());
    setAttendance(d);
    return d;
  };

  const requestScreenShare = async () => activateShare(await getScreenStream());

  const submitAttendance = async e => {
    e?.preventDefault();
    if (faceBusy) return;
    setError('');
    setMessage('');
    setFaceBusy(true);
    let pending = null;
    try {
      // 1) Ask for the screen FIRST, while the click is still a user gesture. Browsers block
      //    getDisplayMedia() if it is called after the (slow) face-recognition request.
      if (!stream.current) {
        try { pending = await getScreenStream(); }
        catch (shareErr) {
          setError(shareErr?.name === 'NotAllowedError'
            ? 'Screen share allow nahi kiya. Attendance mark hogi, phir "Start Screen Share" dabana.'
            : `Screen share could not start: ${shareErr?.message || shareErr}`);
        }
      }

      if (!joinedRef.current && !(await doJoin())) throw new Error('Could not connect to the server.');

      // 2) Face attendance
      const d = mode === 'face' ? await markFaceAttendance() : await markSimpleAttendance();
      nameRef.current = d.employee.name;
      socket.emit('set-employee-name', { name: d.employee.name, employeeId: d.employee.id });

      // 3) Attendance OK -> screen goes live immediately and the admin sees it
      if (pending) {
        activateShare(pending);
        pending = null;
        setError('');
        setMessage(`✓ Attendance marked for ${d.employee.name}. Screen sharing is LIVE.`);
      } else {
        setMessage(`✓ Face attendance marked for ${d.employee.name} at ${formatTime(d.marked_at)}.`);
      }
    } catch (err) {
      pending?.getTracks().forEach(t => t.stop()); // attendance failed -> do not share
      setError(err.message || 'Face attendance failed.');
      stopCamera();
    } finally {
      setFaceBusy(false);
    }
  };

  const startShareAfterAttendance = async () => {
    if (!attendance || sharing || shareBusy) return;
    setError('');
    setShareBusy(true);
    try {
      await requestScreenShare();
      setMessage(`✓ Screen sharing started for ${attendance.employee.name}.`);
    } catch (err) {
      setError(err?.name === 'NotAllowedError' ? 'Screen share was cancelled.' : err.message);
    } finally {
      setShareBusy(false);
    }
  };

  const stop = () => {
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    closeAllPeers();
    setSharing(false);
    setViewers([]);
    lunchRef.current = false;
    setLunch(false);
    accumulated.current = 0;
    startedAt.current = 0;
    breakAccumulated.current = 0;
    lunchStartedAt.current = 0;
    setBreakElapsed(0);
    socket.emit('sharing-status', { sharing: false, lunch: false });
  };

  const startLunch = () => {
    if (!sharing || lunch) return;
    accumulated.current += startedAt.current ? Date.now() - startedAt.current : 0;
    startedAt.current = 0;
    lunchStartedAt.current = Date.now();
    setBreakElapsed(breakAccumulated.current);
    lunchRef.current = true;
    setLunch(true);
    // Keep the peer connection alive but pause the actual shared video during the break.
    stream.current?.getVideoTracks().forEach(t => { t.enabled = false; });
    socket.emit('sharing-status', { sharing: true, lunch: true });
  };

  const resumeWork = () => {
    if (!lunch) return;
    breakAccumulated.current += lunchStartedAt.current ? Date.now() - lunchStartedAt.current : 0;
    setBreakElapsed(breakAccumulated.current);
    lunchStartedAt.current = 0;
    lunchRef.current = false;
    setLunch(false);
    startedAt.current = Date.now();
    stream.current?.getVideoTracks().forEach(t => { t.enabled = true; });
    socket.emit('sharing-status', { sharing: true, lunch: false });
  };

  return (
    <div className="center"><div className="panel employee-panel">
      {!sharing && <button className="link" onClick={onBack}>← Change role</button>}
      <h1>💻 WFH Workspace</h1>
      <p>Face attendance → screen sharing</p>
      <div className={`conn ${connected ? 'ok' : 'bad'}`}>{connected ? '● Connected to server' : '● Reconnecting…'}</div>

      {!attendance && <form onSubmit={submitAttendance}>
        {mode === 'face'
          ? <>
              <video id="face-cam" className="face-preview" autoPlay playsInline muted />
              <button type="submit" disabled={!connected || faceBusy}>
                {faceBusy ? '📷 Recognizing Face…' : '📷 Scan Face & Mark Attendance'}
              </button>
            </>
          : <>
              <input placeholder="Employee naam" value={empName} onChange={e => setEmpName(e.target.value)} required />
              <input placeholder="Employee ID (optional)" value={empId} onChange={e => setEmpId(e.target.value)} />
              <button type="submit" disabled={!connected || faceBusy || !empName.trim()}>
                {faceBusy ? 'Marking attendance…' : '✅ Mark Attendance & Start Screen Share'}
              </button>
            </>}
      </form>}

      {attendance && (
        <div className="status success">
          ✓ <b>{attendance.employee.name}</b> — attendance {attendance.duplicate ? 'already marked' : 'marked'} at {formatTime(attendance.marked_at)}
        </div>
      )}

      {attendance && !sharing && (
        <button onClick={startShareAfterAttendance} disabled={shareBusy}>
          {shareBusy ? 'Starting Screen Share…' : '🖥️ Start Screen Share'}
        </button>
      )}

      {sharing && (
        <>
          <div className="timer-box">
            <div className="timer-label">{lunch ? '🍽 Break' : '⏱ Work Time'}</div>
            <div className="timer">{lunch ? fmtDuration(breakElapsed) : fmtDuration(elapsed)}</div>
            <div className="break-total">🍽 Total break: {fmtDuration(breakElapsed)}</div>
          </div>

          <div className="share-actions">
            {!lunch
              ? <button className="lunch-btn" onClick={startLunch}>🍽 Break</button>
              : <button className="resume-btn" onClick={resumeWork}>▶ Resume Work</button>}
            <button className="danger" onClick={stop}>⏹ Stop Sharing</button>
          </div>

          {!lunch && <div className="status">🟢 Screen sharing is active · Work time {fmtDuration(elapsed)}</div>}
          {lunch && <div className="status idle">🍽 Break active. Shared screen is paused. Work timer is stopped.</div>}
          {viewers.length > 0
            ? <div className="status watching">👁 Being viewed live by: <b>{viewers.join(', ')}</b></div>
            : <div className="status idle">Nobody is viewing right now.</div>}
        </>
      )}

      {message && <div className="status">{message}</div>}
      {error && <div className="status err">{error}</div>}

      <small>
        {mode === 'face' ? 'Face recognition identifies you automatically; after successful attendance, screen sharing starts.' : 'Attendance mark hote hi aapki screen live share hoti hai aur admin ko dikhti hai.'}
        During the break the work timer stops, the shared screen is paused, and break time is counted. Click Resume Work whenever you are ready to continue.
      </small>
    </div></div>
  );
}

function formatTime(value) {
  try { return new Date(value).toLocaleTimeString(); } catch { return value; }
}
