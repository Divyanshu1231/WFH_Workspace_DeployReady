import React, { useEffect, useRef, useState } from 'react';
import { socket, useConnected } from './socket';
import { createPeerAsync } from './rtc';
import { fmtDuration } from './utils';
import { FACE_API_URL, SERVER_URL, faceFetch, loadIceServers, wakeFaceService, setFaceApiUrl, testFaceService, loadServerConfig, getAttendanceMode } from './config';

function ScreenVideo({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || !stream) return;
    let stopped = false;
    const attach = () => {
      if (stopped || !ref.current) return;
      const v = ref.current;
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      if (v.srcObject !== stream) v.srcObject = stream;
      v.play().catch(() => {});
    };
    const tracks = stream.getVideoTracks();
    tracks.forEach(track => {
      track.enabled = true;
      track.onunmute = attach;
    });
    attach();
    const retry = setInterval(attach, 1000);
    return () => {
      stopped = true;
      clearInterval(retry);
      tracks.forEach(track => { track.onunmute = null; });
      if (ref.current) ref.current.srcObject = null;
    };
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted style={{width:'100%',height:'100%',objectFit:'contain',display:'block'}} />;
}

const STATUS_TEXT = {
  connecting: 'Connecting…',
  relaying: 'Direct connection failed - retrying through Metered TURN relay…',
  failed: 'Connection failed even via relay. Check that METERED_DOMAIN and METERED_API_KEY are set on the server (open /api/ice-check), then click Retry.',
};

function EmployeeCard({ e, stream, status, now, onWatch, onStop }) {
  const screenRef = useRef(null);
  const fullscreen = () => screenRef.current?.requestFullscreen?.();
  const watching = !!status;

  return (
    <div className="card">
      <div className="cardhead">
        <b>{e.name}</b>
        <span className={e.sharing ? 'on' : 'off'}>
          {e.lunch ? `🍽 LUNCH ${e.lunchSince ? fmtDuration(now - e.lunchSince) : ''}` : e.sharing ? `● LIVE ${e.sharingSince ? fmtDuration(now - e.sharingSince) : ''}` : '● NOT SHARING'}
        </span>
      </div>
      <div className="screen" ref={screenRef} onDoubleClick={fullscreen}>
        {stream && status === 'live'
          ? <ScreenVideo stream={stream} />
          : <div className="placeholder">{status ? STATUS_TEXT[status] : e.sharing ? 'Click View to start' : 'Employee is not sharing'}</div>}
      </div>
      <div className="actions">
        {watching
          ? <button className="secondary" onClick={() => onStop(e.id)}>⏹ Stop Viewing</button>
          : <button disabled={!e.sharing} onClick={() => onWatch(e.id, false)}>View Live Screen</button>}
        {status === 'failed' && <button onClick={() => onWatch(e.id, true)}>Retry (via relay)</button>}
        {status === 'live' && <button className="ghost" onClick={fullscreen} title="Fullscreen (or double-click)">⛶</button>}
      </div>
    </div>
  );
}

export default function Admin({ onBack }) {
  const [auth, setAuth] = useState(false);
  const [username, setUsername] = useState(() => localStorage.getItem('wfh-admin-user') || '');
  const [adminLabel, setAdminLabel] = useState('');
  const [password, setPassword] = useState('');
  const [tab, setTab] = useState('employees');
  const [reg, setReg] = useState({ id: '', name: '', department: '' });
  const [regEmployee, setRegEmployee] = useState(null);
  const [regBusy, setRegBusy] = useState(false);
  const [regMessage, setRegMessage] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [faceSamples, setFaceSamples] = useState(0);
  const regVideoRef = useRef(null);
  const regCameraRef = useRef(null);
  const [attendanceRows, setAttendanceRows] = useState([]);

  const formatTime = value => { try { return new Date(value).toLocaleTimeString(); } catch { return value; } };
  const [error, setError] = useState('');
  const [employees, setEmployees] = useState([]);
  const [streams, setStreams] = useState({});
  const [status, setStatus] = useState({}); // id -> 'connecting' | 'live' | 'failed'
  const [query, setQuery] = useState('');
  const [size, setSize] = useState('md');
  const [now, setNow] = useState(Date.now());
  const connected = useConnected();

  const peers = useRef({});
  const early = useRef({});     // ICE candidates that arrived before their offer
  const timers = useRef({});
  const watching = useRef(new Set());
  const creds = useRef(null);
  const manualStop = useRef(new Set());  // employees the admin closed by hand: do not auto-reopen
  const [mode, setMode] = useState(getAttendanceMode());
  useEffect(() => { loadServerConfig().then(() => setMode(getAttendanceMode())); }, []);
  const attBase = () => (mode === 'face' ? FACE_API_URL : SERVER_URL);
  const attFetch = (url, opts) => (mode === 'face' ? faceFetch(url, opts) : fetch(url, opts));
  const [autoView, setAutoView] = useState(true);
  const autoRef = useRef(true);
  autoRef.current = autoView;
  const relayMode = useRef({});   // id -> true once we switched to TURN-relay-only for that employee
  const mediaReady = useRef({});  // id -> true after a real remote video track arrives
  const [turnOk, setTurnOk] = useState(null);
  const [faceStatus, setFaceStatus] = useState('checking'); // checking | online | waking | offline
  const [faceUrlInput, setFaceUrlInput] = useState(FACE_API_URL);
  const [faceUrlMsg, setFaceUrlMsg] = useState('');
  const [faceUrlVer, setFaceUrlVer] = useState(0);

  const setStat = (id, v) => setStatus(s => ({ ...s, [id]: v }));
  const removeViewer = id => {
    peers.current[id]?.close();
    delete peers.current[id];
    delete early.current[id];
    delete relayMode.current[id];
    delete mediaReady.current[id];
    clearTimeout(timers.current[id]);
    watching.current.delete(id);
    setStreams(s => { const { [id]: _, ...rest } = s; return rest; });
    setStatus(s => { const { [id]: _, ...rest } = s; return rest; });
  };

  useEffect(() => {
    return () => stopRegCamera();
  }, []);

  useEffect(() => { loadIceServers({ force: true }).then(setTurnOk); }, []);

  useEffect(() => {
    if (!auth || tab !== 'register') return;
    let dead = false;
    (async () => {
      setFaceStatus('checking');
      try {
        const r = await fetch(`${FACE_API_URL}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
        const j = await r.json().catch(() => null);
        if (!dead && r.ok && j?.lbph_available === true) return setFaceStatus('online');
        if (!dead && r.ok && j && 'uptime' in j) return setFaceStatus('wrong');
      } catch { /* sleeping or unreachable */ }
      if (dead) return;
      setFaceStatus('waking');
      const ok = await wakeFaceService(120000);
      if (!dead) setFaceStatus(ok ? 'online' : 'offline');
    })();
    return () => { dead = true; };
  }, [auth, tab, faceUrlVer]);

  useEffect(() => {
    const onEmployees = list => {
      setEmployees(list);
      const live = new Set(list.filter(x => x.sharing).map(x => x.id));
      [...watching.current].forEach(id => { if (!live.has(id)) removeViewer(id); });
      [...manualStop.current].forEach(id => { if (!live.has(id)) manualStop.current.delete(id); });
      // Auto-view: as soon as an employee starts sharing (after attendance), show the screen.
      if (autoRef.current) {
        list.forEach(x => {
          if (x.sharing && !watching.current.has(x.id) && !manualStop.current.has(x.id)) startWatch(x.id, false);
        });
      }
    };
    const onOffer = async ({ from, offer }) => {
      if (!watching.current.has(from)) return;
      peers.current[from]?.close();
      const peer = await createPeerAsync(from, socket, {
        relayOnly: !!relayMode.current[from],
        onTrack: ev => {
          const incoming = ev.streams?.[0];
          const stream = incoming || new MediaStream([ev.track]);
          setStreams(s => {
            const prev = s[from];
            if (prev && !incoming && ev.track && !prev.getTracks().includes(ev.track)) prev.addTrack(ev.track);
            return { ...s, [from]: incoming || prev || stream };
          });
          // NOTE: ontrack fires as soon as the offer is applied - BEFORE any media flows.
          // So do NOT mark live / cancel the fail-over timer here (that caused the black screen).
        },
        onState: st => {
          if (st === 'connected') {
            clearTimeout(timers.current[from]);
            mediaReady.current[from] = true;
            setStat(from, 'live');
            // Watchdog: connected but no video frames decoded -> retry through the TURN relay.
            setTimeout(async () => {
              const pc = peers.current[from]?.pc;
              if (!pc || !watching.current.has(from) || pc.connectionState !== 'connected') return;
              try {
                const stats = await pc.getStats();
                let frames = 0;
                stats.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') frames += r.framesDecoded || 0; });
                if (!frames) failOver(from);
              } catch { /* ignore */ }
            }, 7000);
          }
          if (st === 'failed' && watching.current.has(from)) failOver(from);
        },
      });
      peers.current[from] = peer;
      (early.current[from] || []).forEach(c => peer.addCandidate(c));
      delete early.current[from];
      await peer.setRemote(offer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('webrtc-answer', { to: from, answer });
    };
    const onIce = ({ from, candidate }) => {
      const peer = peers.current[from];
      if (peer) peer.addCandidate(candidate);
      else (early.current[from] = early.current[from] || []).push(candidate);
    };
    const onConnect = () => { if (creds.current) socket.emit('join', creds.current, () => {}); };

    socket.on('employees', onEmployees);
    socket.on('webrtc-offer', onOffer);
    socket.on('ice-candidate', onIce);
    socket.on('connect', onConnect);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      socket.off('employees', onEmployees);
      socket.off('webrtc-offer', onOffer);
      socket.off('ice-candidate', onIce);
      socket.off('connect', onConnect);
      clearInterval(tick);
      Object.values(peers.current).forEach(p => p.close());
      Object.values(timers.current).forEach(clearTimeout);
    };
  }, []);

  const faceHeaders = () => ({ 'Content-Type': 'application/json', 'X-Admin-User': username.trim(), 'X-Admin-Password': password });

  const loadAttendance = async () => {
    try {
      const r = await attFetch(`${attBase()}/api/admin/attendance`, { headers: faceHeaders() });
      if (r.ok) setAttendanceRows(await r.json());
    } catch (e) { console.error(e); }
  };

  const saveAndTestFaceUrl = async () => {
    const url = setFaceApiUrl(faceUrlInput);
    setFaceUrlInput(url);
    setFaceStatus('waking');
    setFaceUrlMsg('⏳ Test ho raha hai (sleeping service ko jagne me 1 min lag sakta hai)…');
    const res = await testFaceService(url);
    setFaceUrlMsg(res.msg);
    setFaceStatus(res.ok ? 'online' : 'offline');
    setFaceUrlVer(v => v + 1);
  };

  const addEmployee = async e => {
    e.preventDefault(); setRegBusy(true);
    setRegMessage(faceStatus === 'online'
      ? 'Creating employee…'
      : '⏳ Face service jag rahi hai (Render free plan, 1-2 min lag sakte hain). Please wait…');
    try {
      const r = await faceFetch(`${FACE_API_URL}/api/admin/employees`, { method: 'POST', headers: faceHeaders(), body: JSON.stringify(reg) });
      const d = await r.json().catch(() => ({}));
      if (r.ok || r.status === 409) setFaceStatus('online');
      const created = { ...reg };
      if (r.status === 409) {
        // Already created earlier (e.g. face capture was never finished) -> go straight to face capture.
        setRegEmployee(created);
        setFaceSamples(0);
        setRegMessage(`Employee ${created.id} pehle se bana hua hai. Face camera khul raha hai — 3 face samples capture karo.`);
        return;
      }
      if (!r.ok) throw new Error(d.detail || (r.status === 404 || r.status === 405
        ? `HTTP ${r.status}: ye URL face service ka nahi hai (shayad WFH Node app ka URL daal diya). Face service ka alag Python URL chahiye.`
        : `Face service ne HTTP ${r.status} diya.`));
      setRegEmployee(created);
      setFaceSamples(0);
      setReg({ id: '', name: '', department: '' });
      setRegMessage(`✓ Employee ${created.name} created. Ab face camera khul raha hai — 3 samples capture karo.`);
    } catch (e) {
      const message = e?.message === 'Failed to fetch'
        ? `Face service is not reachable at ${FACE_API_URL}. Render par wfh-face-attendance service deploy/running honi chahiye (URL me :8000 mat lagao).`
        : e.message;
      setRegMessage(message || 'Could not register employee');
    } finally { setRegBusy(false); }
  };

  useEffect(() => {
    if (!regEmployee) return;
    const t = setTimeout(() => startRegCamera(), 150);
    return () => clearTimeout(t);
  }, [regEmployee]);

  const stopRegCamera = () => {
    regCameraRef.current?.getTracks().forEach(t => t.stop());
    regCameraRef.current = null;
    if (regVideoRef.current) regVideoRef.current.srcObject = null;
    setCameraOpen(false);
  };

  const startRegCamera = async () => {
    setRegMessage('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera is unavailable. Open this app on localhost or HTTPS and use Chrome/Edge.');
      stopRegCamera();
      const st = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      regCameraRef.current = st;
      setCameraOpen(true);
      requestAnimationFrame(async () => {
        if (regVideoRef.current) {
          regVideoRef.current.srcObject = st;
          try { await regVideoRef.current.play(); } catch {}
        }
      });
      setRegMessage('Camera is ready. Keep one face inside the frame and click Capture Sample.');
    } catch (e) {
      const detail = e?.name === 'NotAllowedError' ? 'Camera permission was denied. Click the camera icon in the browser address bar and Allow camera.'
        : e?.name === 'NotFoundError' ? 'No camera was found on this computer.'
        : e?.message || 'Could not open camera.';
      setRegMessage(detail);
      setCameraOpen(false);
    }
  };

  const captureOneSample = async () => {
    if (!regEmployee || regBusy || !regVideoRef.current || !regCameraRef.current) return;
    setRegBusy(true);
    try {
      const video = regVideoRef.current;
      if (!video.videoWidth || !video.videoHeight) throw new Error('Camera is still starting. Wait 1-2 seconds and try again.');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const r = await faceFetch(`${FACE_API_URL}/api/admin/employees/${encodeURIComponent(regEmployee.id)}/face`, {
        method: 'POST', headers: faceHeaders(), body: JSON.stringify({ image: canvas.toDataURL('image/jpeg', .92) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail || `Face capture failed (HTTP ${r.status})`);
      setFaceSamples(d.samples || 0);
      if ((d.samples || 0) >= 3) {
        setRegMessage('✓ Face registration complete. Employee can now mark attendance using face only.');
        stopRegCamera();
        setRegEmployee(null);
      } else {
        setRegMessage(`✓ Face sample ${d.samples}/3 captured. Change your angle slightly and capture the next sample.`);
      }
    } catch (e) {
      setRegMessage(e.message || 'Face capture failed.');
    } finally {
      setRegBusy(false);
    }
  };

  useEffect(() => {
    if (tab !== 'attendance') return;
    loadAttendance();
    const t = setInterval(loadAttendance, 5000);
    return () => clearInterval(t);
  }, [tab]);

  const exportAttendance = async () => {
    try {
      const r=await attFetch(`${attBase()}/api/admin/attendance/export`, { headers: faceHeaders() });
      if(!r.ok) throw new Error('Export failed');
      const blob=await r.blob(); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='attendance.csv'; a.click(); URL.revokeObjectURL(url);
    } catch(e) { setRegMessage(e.message); }
  };

  const login = e => {
    e.preventDefault();
    setError('');
    const c = { role: 'admin', username: username.trim(), password };
    socket.emit('join', c, res => {
      if (res?.ok) { creds.current = c; localStorage.setItem('wfh-admin-user', c.username); setAdminLabel(res.name || ''); setAuth(true); }
      else setError(res?.error || 'Login failed');
    });
  };


  // First try a normal connection. If it fails and TURN is available, automatically retry through the relay.
  const failOver = id => {
    if (!watching.current.has(id)) return;
    if (!relayMode.current[id]) { startWatch(id, true); setStat(id, 'relaying'); }
    else setStat(id, 'failed');
  };

  const startWatch = (id, relay) => {
    relayMode.current[id] = relay;
    watching.current.add(id);
    peers.current[id]?.close();
    delete peers.current[id];
    delete early.current[id];
    mediaReady.current[id] = false;
    setStreams(s => { const { [id]: _, ...rest } = s; return rest; });
    if (!relay) setStat(id, 'connecting');
    socket.emit('watch', { id, relay });
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => {
      if (!watching.current.has(id)) return;
      const pc = peers.current[id]?.pc;
      const hasVideo = !!mediaReady.current[id];
      if (!hasVideo || !pc || !['connected','completed'].includes(pc.iceConnectionState)) failOver(id);
    }, relay ? 18000 : 10000);
  };

  // Manual click / Retry: Retry goes straight to relay mode, which works on almost every network.
  const watch = (id, retry = false) => { manualStop.current.delete(id); startWatch(id, retry); };
  const stopWatching = id => { manualStop.current.add(id); socket.emit('unwatch', id); removeViewer(id); };

  if (!auth) {
    return (
      <div className="center"><div className="panel">
        <button className="link" onClick={onBack}>← Change role</button>
        <h1>👨‍💼 Admin Login</h1>
        <p>Single Admin mode: you can view every connected employee.</p>
        <form onSubmit={login}>
          <input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} autoCapitalize="none" autoFocus />
          <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
          {error && <div className="status err">{error}</div>}
          <button type="submit" disabled={!username.trim() || !password || !connected}>Sign in</button>
        </form>
        <small>Admin credentials are set with ADMIN_USER and ADMIN_PASSWORD on the server.</small>
      </div></div>
    );
  }

  const q = query.trim().toLowerCase();
  const list = employees
    .filter(e => !q || e.name.toLowerCase().includes(q))
    .sort((a, b) => Number(b.sharing) - Number(a.sharing) || a.name.localeCompare(b.name));
  const sharingCount = employees.filter(e => e.sharing).length;

  return (
    <div className="admin">
      <header>
        <div><h1>WFH Admin Workspace</h1><span>{adminLabel ? `Signed in as ${adminLabel} · ` : ''}Your assigned employees</span></div>
        <div className="headright">
          <div className={`conn ${connected ? 'ok' : 'bad'}`}>{connected ? '● Online' : '● Reconnecting…'}</div>
          <div className="pill" title="Metered TURN relay lets remote employees connect from any network">{turnOk === null ? '🌐 TURN…' : turnOk ? '🌐 TURN relay ON' : '⚠️ TURN not configured'}</div>
          <div className="pill">👥 {employees.length} Online</div>
          <div className="pill">🟢 {sharingCount} Sharing</div>
          <button className="ghost" onClick={onBack}>Sign out</button>
        </div>
      </header>
      <div className="admin-tabs">
        <button className={tab === 'employees' ? 'active' : ''} onClick={() => setTab('employees')}>👥 Live Employees</button>
        {mode === 'face' && <button className={tab === 'register' ? 'active' : ''} onClick={() => setTab('register')}>➕ Register Employee</button>}
        <button className={tab === 'attendance' ? 'active' : ''} onClick={() => { setTab('attendance'); loadAttendance(); }}>📋 Attendance & CSV</button>
      </div>
      {tab === 'employees' && <>
        <div className="toolbar">
          <input placeholder="Search employee…" value={query} onChange={e => setQuery(e.target.value)} />
          <label className="autoview"><input type="checkbox" checked={autoView} onChange={e => setAutoView(e.target.checked)} /> Auto-view when employee starts sharing</label>
          <select value={size} onChange={e => setSize(e.target.value)}>
            <option value="sm">Small tiles</option><option value="md">Medium tiles</option><option value="lg">Large tiles</option>
          </select>
        </div>
        <main className={`size-${size}`}>
          {employees.length === 0 && <div className="empty">No employees are online.</div>}
          {employees.length > 0 && list.length === 0 && <div className="empty">No employee matches “{query}”.</div>}
          {list.map(e => <EmployeeCard key={e.id} e={e} stream={streams[e.id]} status={status[e.id]} now={now} onWatch={watch} onStop={stopWatching} />)}
        </main>
      </>}
      {tab === 'register' && mode === 'face' && <section className="admin-section">
        <div className="admin-form-card"><h2>Register Employee Face</h2><p>Step 1: Employee create karo → Step 2: camera se 3 face samples capture karo.</p>
          <div className="face-url-box">
            <label>Face service URL (Render ka Python service URL)</label>
            <input value={faceUrlInput} onChange={e => setFaceUrlInput(e.target.value)} placeholder="https://wfh-face-attendance.onrender.com" />
            <button type="button" onClick={saveAndTestFaceUrl}>Save & Test</button>
            {faceUrlMsg && <div className={`status ${faceUrlMsg.startsWith('✓') ? 'success' : ''}`}>{faceUrlMsg}</div>}
          </div>
          <div className={`status ${faceStatus === 'online' ? 'success' : ''}`}>
            {faceStatus === 'online' ? '● Face service online' : faceStatus === 'wrong' ? '❌ Ye WFH Node app ka URL hai, face service ka nahi — alag Python service chahiye' : faceStatus === 'offline' ? '● Face service offline — Render service check karo' : '⏳ Face service jag rahi hai… (1-2 min)'}
          </div>
          <form onSubmit={addEmployee}>
            <input placeholder="Employee ID" value={reg.id} onChange={e=>setReg({...reg,id:e.target.value})} required />
            <input placeholder="Employee Name" value={reg.name} onChange={e=>setReg({...reg,name:e.target.value})} required />
            <input placeholder="Department (optional)" value={reg.department} onChange={e=>setReg({...reg,department:e.target.value})} />
            <button type="submit" disabled={regBusy}>{regBusy ? (regEmployee ? 'Please wait…' : 'Creating…') : 'Create Employee & Add Face'}</button>
          </form>
          {regEmployee && <div className="face-register-box">
            <b>Register face for: {regEmployee.name}</b>
            <span>Samples: {faceSamples}/3 · Keep exactly one face clearly visible.</span>
            <video ref={regVideoRef} className="face-preview register-camera" autoPlay playsInline muted />
            {!cameraOpen
              ? <button type="button" onClick={startRegCamera} disabled={regBusy}>📷 Open Face Camera</button>
              : <div className="capture-row"><button type="button" onClick={captureOneSample} disabled={regBusy}>📸 Capture Face Sample</button><button type="button" className="secondary" onClick={stopRegCamera} disabled={regBusy}>Close Camera</button></div>}
          </div>}
          {regMessage && <div className={`status ${regMessage.startsWith('✓') ? 'success' : ''}`}>{regMessage}</div>}
        </div>
      </section>}
      {tab === 'attendance' && <section className="admin-section">
        <div className="attendance-panel"><div className="attendance-head"><div><h2>Attendance Records</h2><p>Today's attendance records</p></div><div><button onClick={loadAttendance}>↻ Refresh</button><button onClick={exportAttendance}>⬇ Export All CSV</button></div></div>
          <div className="table-wrap"><table><thead><tr><th>Employee ID</th><th>Name</th><th>Department</th><th>Date</th><th>Time</th><th>Working Time</th><th>Break Time</th><th>Status</th></tr></thead><tbody>{attendanceRows.map(r=><tr key={r.id}><td>{r.employee_id}</td><td>{r.name}</td><td>{r.department || '-'}</td><td>{r.marked_at.slice(0,10)}</td><td>{formatTime(r.marked_at)}</td><td>{fmtDuration(r.work_ms)}</td><td>{fmtDuration(r.break_ms)}</td><td>{r.last_status || 'present'}</td></tr>)}{attendanceRows.length===0&&<tr><td colSpan="8">No attendance records for today.</td></tr>}</tbody></table></div>
        </div>
      </section>}
    </div>
  );
}
