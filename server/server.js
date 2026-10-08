import express from 'express';
import cors from 'cors';
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.CLIENT_ORIGIN || '*';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const ATT_FILE = process.env.ATTENDANCE_FILE || path.join(__dirname, 'attendance.json');
const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MIN ?? 330); // India (IST) by default

const app = express();
app.use(cors({ origin: ORIGIN === '*' ? true : ORIGIN }));
app.use(express.json({ limit: '2mb' }));
app.get('/api/health', (_, res) => res.json({ ok: true, uptime: process.uptime() }));

let meteredCache = { at: 0, servers: null };
let meteredError = null;
const meteredDomain = () => (process.env.METERED_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');

async function meteredServers() {
  const domain = meteredDomain(), key = (process.env.METERED_API_KEY || '').trim();
  if (!domain || !key) { meteredError = 'METERED_DOMAIN / METERED_API_KEY not set'; return null; }
  // Metered credentials stay valid for a long time, but refresh often so a bad/expired set never sticks.
  if (meteredCache.servers && Date.now() - meteredCache.at < 5 * 60 * 1000) return meteredCache.servers;
  try {
    const r = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${domain}`);
    const list = await r.json();
    if (!Array.isArray(list) || !list.length) throw new Error('Metered returned an empty list');
    meteredCache = { at: Date.now(), servers: list };
    meteredError = null;
    return list;
  } catch (e) {
    meteredError = e.message;
    console.error('Metered ICE fetch failed:', e.message);
  }
  return meteredCache.servers; // last good copy, if any
}

// Cloudflare Realtime TURN (free: first 1000 GB / month). Set CF_TURN_KEY_ID + CF_TURN_API_TOKEN to use it.
let cfCache = { at: 0, servers: null };
let cfError = null;
async function cloudflareServers() {
  const keyId = (process.env.CF_TURN_KEY_ID || '').trim(), token = (process.env.CF_TURN_API_TOKEN || '').trim();
  if (!keyId || !token) return null;
  if (cfCache.servers && Date.now() - cfCache.at < 30 * 60 * 1000) return cfCache.servers;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from Cloudflare TURN`);
    const j = await r.json();
    const list = [].concat(j.iceServers || []).filter(x => x && x.urls);
    if (!list.length) throw new Error('Cloudflare returned no iceServers');
    cfCache = { at: Date.now(), servers: list };
    cfError = null;
    return list;
  } catch (e) {
    cfError = e.message;
    console.error('Cloudflare TURN fetch failed:', e.message);
  }
  return cfCache.servers;
}

async function buildIce() {
  // Cloudflare configured -> use it and skip Metered/static TURN (dead servers only slow ICE down).
  if ((process.env.CF_TURN_KEY_ID || '').trim()) {
    const cf = await cloudflareServers();
    if (cf) return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...cf], turn: true };
  }
  return buildIceLegacy();
}

async function buildIceLegacy() {
  let iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  let turn = false;
  const metered = await meteredServers();
  if (metered) { iceServers = [...iceServers, ...metered]; turn = true; }
  const urls = (process.env.TURN_URLS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (urls.length) { iceServers.push({ urls, username: process.env.TURN_USER, credential: process.env.TURN_PASS }); turn = true; }
  return { iceServers, turn };
}

// Runtime config. mode "simple" = attendance by name inside this Node app (no Python face service needed).
// mode "face" = face-recognition attendance via the separate Python service (set FACE_API_URL).
app.get('/api/config', (_, res) => {
  const faceApiUrl = (process.env.FACE_API_URL || '').trim() || null;
  const mode = process.env.ATTENDANCE_MODE === 'face' || (faceApiUrl && process.env.ATTENDANCE_MODE !== 'simple') ? 'face' : 'simple';
  res.set('Cache-Control', 'no-store').json({ faceApiUrl, mode });
});

// ---------- Simple attendance (name based) ----------
let attendance = [];
try { attendance = JSON.parse(fs.readFileSync(ATT_FILE, 'utf8')); } catch { /* first run */ }
const saveAttendance = () => { try { fs.writeFileSync(ATT_FILE, JSON.stringify(attendance)); } catch (e) { console.error('attendance save failed:', e.message); } };
const todayKey = () => localIso().slice(0, 10);
const findTodayAttendance = u => {
  const today = todayKey();
  return attendance.find(r => r.employee_id === u.employeeId && r.marked_at.slice(0, 10) === today)
    || attendance.find(r => r.name === u.name && r.marked_at.slice(0, 10) === today);
};
const restoreTotals = u => {
  const saved = findTodayAttendance(u);
  if (!saved) return;
  u.workMs = Math.max(u.workMs || 0, Number(saved.work_ms) || 0);
  u.breakMs = Math.max(u.breakMs || 0, Number(saved.break_ms) || 0);
};
const sendTotals = u => io.to(u.id).emit('session-totals', { workMs: Math.round(u.workMs || 0), breakMs: Math.round(u.breakMs || 0) });
const updateAttendanceSession = (u, persist = true) => {
  const row = findTodayAttendance(u);
  if (!row) return;
  const now = Date.now();
  if (u.workStartedAt) { u.workMs += Math.max(0, now - u.workStartedAt); u.workStartedAt = now; }
  if (u.breakStartedAt) { u.breakMs += Math.max(0, now - u.breakStartedAt); u.breakStartedAt = now; }
  // never let a fresh/reconnected session overwrite larger saved totals with smaller ones
  row.work_ms = Math.max(Number(row.work_ms) || 0, Math.round(u.workMs));
  row.break_ms = Math.max(Number(row.break_ms) || 0, Math.round(u.breakMs));
  row.last_status = u.sharing ? (u.lunch ? 'break' : 'working') : 'stopped';
  row.updated_at = localIso();
  if (persist) saveAttendance();
};
const flushSession = u => {
  if (!u || u.role !== 'employee') return;
  const now = Date.now();
  if (u.workStartedAt) { u.workMs += Math.max(0, now - u.workStartedAt); u.workStartedAt = 0; }
  if (u.breakStartedAt) { u.breakMs += Math.max(0, now - u.breakStartedAt); u.breakStartedAt = 0; }
  const row = findTodayAttendance(u);
  if (row) { row.work_ms = Math.max(Number(row.work_ms) || 0, Math.round(u.workMs)); row.break_ms = Math.max(Number(row.break_ms) || 0, Math.round(u.breakMs)); row.last_status = 'stopped'; row.updated_at = localIso(); saveAttendance(); }
};

const localIso = () => {
  const d = new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 19);
  const a = Math.abs(TZ_OFFSET_MIN), sign = TZ_OFFSET_MIN >= 0 ? '+' : '-';
  return `${d}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
};
const adminAuth = (req, res, next) => {
  if (String(req.get('x-admin-user') || '').trim() !== ADMIN_USER || String(req.get('x-admin-password') || '') !== ADMIN_PASSWORD)
    return res.status(401).json({ detail: 'Wrong admin credentials' });
  next();
};

app.post('/api/attendance', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const empId = String(req.body?.employeeId || '').trim().slice(0, 30) || name.toLowerCase().replace(/\s+/g, '-');
  if (!name) return res.status(400).json({ detail: 'Naam likhna zaroori hai' });
  const now = localIso();
  const today = now.slice(0, 10);
  const existing = attendance.find(r => r.employee_id === empId && r.marked_at.slice(0, 10) === today);
  if (existing) return res.json({ employee: { id: empId, name }, marked_at: existing.marked_at, duplicate: true });
  const row = { id: attendance.length + 1, employee_id: empId, name, department: '', marked_at: now, work_ms: 0, break_ms: 0, last_status: 'present' };
  attendance.push(row);
  saveAttendance();
  res.json({ employee: { id: empId, name }, marked_at: now, duplicate: false });
});

app.get('/api/admin/attendance', adminAuth, (_, res) => {
  const today = localIso().slice(0, 10);
  const now = Date.now();
  const live = r => {
    const u = [...users.values()].find(x => x.role === 'employee' && x.sharing &&
      ((r.employee_id && x.employeeId === r.employee_id) || x.name === r.name));
    if (!u) return r;
    return {
      ...r,
      work_ms: Math.max(Number(r.work_ms) || 0, Math.round((u.workMs || 0) + (u.workStartedAt ? now - u.workStartedAt : 0))),
      break_ms: Math.max(Number(r.break_ms) || 0, Math.round((u.breakMs || 0) + (u.breakStartedAt ? now - u.breakStartedAt : 0))),
      last_status: u.lunch ? 'break' : 'working',
    };
  };
  res.json(attendance.filter(r => r.marked_at.slice(0, 10) === today).reverse().map(live));
});

app.get('/api/admin/attendance/export', adminAuth, (_, res) => {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const fmt = ms => { ms = Math.max(0, Number(ms) || 0); const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000); return `${h}h ${m}m ${s}s`; };
  const lines = ['Employee ID,Name,Department,Date,Time,Working Time,Break Time,Status', ...attendance.map(r =>
    [r.employee_id, r.name, r.department, r.marked_at.slice(0, 10), r.marked_at.slice(11, 19), fmt(r.work_ms), fmt(r.break_ms), r.last_status || 'present'].map(esc).join(','))];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="attendance.csv"' }).send(lines.join('\n'));
});

app.get('/api/ice', async (_, res) => {
  res.set('Cache-Control', 'no-store').json(await buildIce());
});

// Diagnostic: open https://<your-app>/api/ice-check to see whether TURN is really working (no secrets shown).
app.get('/api/ice-check', async (_, res) => {
  const { iceServers, turn } = await buildIce();
  const relay = iceServers.filter(s => [].concat(s.urls).some(u => /^turns?:/i.test(u)));
  res.set('Cache-Control', 'no-store').json({
    turn,
    relayServers: relay.length,
    relayUrls: relay.flatMap(s => [].concat(s.urls)),
    meteredDomain: meteredDomain() || null,
    meteredError,
    cloudflareConfigured: !!(process.env.CF_TURN_KEY_ID || '').trim(),
    cloudflareError: cfError,
  });
});

const dist = path.join(__dirname, '../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: ORIGIN } });

// One admin only. Every connected employee is visible to that admin.
const users = new Map();
const viewers = new Map();

const employeeInfo = u => ({
  id: u.id,
  name: u.name,
  sharing: !!u.sharing,
  sharingSince: u.sharingSince,
  lunch: !!u.lunch,
  lunchSince: u.lunchSince,
  viewers: viewers.get(u.id)?.size || 0,
  workMs: u.workMs || 0,
  breakMs: u.breakMs || 0,
});

const broadcastEmployees = () => {
  const emps = [...users.values()].filter(u => u.role === 'employee');
  const payload = emps.map(employeeInfo);
  for (const u of users.values()) {
    if (u.role === 'admin') io.to(u.id).emit('employees', payload);
  }
};

const sendViewers = employeeId =>
  io.to(employeeId).emit('viewers', [...(viewers.get(employeeId) || [])].map(id => users.get(id)?.name || 'Admin'));

const removeViewer = (employeeId, adminId, notifyEmployee = true) => {
  const set = viewers.get(employeeId);
  if (!set || !set.delete(adminId)) return;
  if (!set.size) viewers.delete(employeeId);
  if (notifyEmployee) {
    io.to(employeeId).emit('unwatch', { adminId });
    sendViewers(employeeId);
  }
};

io.on('connection', socket => {
  let failedLogins = 0;
  const me = () => users.get(socket.id);

  socket.on('join', (payload = {}, ack = () => {}) => {
    const role = payload.role;
    const clean = String(payload.name || '').trim().slice(0, 40);

    if (role === 'admin') {
      if (String(payload.username || '').trim() !== ADMIN_USER ||
          String(payload.password || '') !== ADMIN_PASSWORD) {
        if (++failedLogins >= 5) socket.disconnect(true);
        return ack({ ok: false, error: 'Wrong admin credentials' });
      }
      users.set(socket.id, { id: socket.id, role: 'admin', name: 'Admin' });
      ack({ ok: true, name: 'Admin' });
      broadcastEmployees();
      return;
    }

    if (role === 'employee') {
      const eu = {
        id: socket.id,
        role,
        name: clean || 'Employee',
        employeeId: String(payload.employeeId || '').trim(),
        sharing: false,
        sharingSince: null,
        lunch: false,
        lunchSince: null,
        workMs: 0,
        breakMs: 0,
        workStartedAt: 0,
        breakStartedAt: 0,
      };
      users.set(socket.id, eu);
      restoreTotals(eu);
      ack({ ok: true });
      sendTotals(eu);
      broadcastEmployees();
      return;
    }

    ack({ ok: false, error: 'Invalid role' });
  });

  socket.on('set-employee-name', payload => {
    const u = me();
    if (u?.role !== 'employee') return;
    const cleanName = String(typeof payload === 'object' ? payload.name : payload || '').trim().slice(0, 40);
    if (!cleanName) return;
    u.name = cleanName;
    if (typeof payload === 'object' && payload.employeeId) u.employeeId = String(payload.employeeId).trim().slice(0, 30);
    restoreTotals(u);
    sendTotals(u);
    broadcastEmployees();
  });

  socket.on('sharing-status', payload => {
    const u = me();
    if (u?.role !== 'employee') return;
    const sharing = typeof payload === 'object' ? !!payload.sharing : !!payload;
    const lunch = typeof payload === 'object' ? !!payload.lunch : false;
    const now = Date.now();
    if (sharing && !u.sharing) {
      restoreTotals(u);
      u.sharingSince = now;
      if (lunch) u.breakStartedAt = now; else u.workStartedAt = now;
    }
    if (sharing && u.sharing && !u.lunch && lunch) {
      if (u.workStartedAt) { u.workMs += now - u.workStartedAt; u.workStartedAt = 0; }
      u.breakStartedAt = now;
    }
    if (sharing && u.sharing && u.lunch && !lunch) {
      if (u.breakStartedAt) { u.breakMs += now - u.breakStartedAt; u.breakStartedAt = 0; }
      u.workStartedAt = now;
    }
    if (!sharing) {
      flushSession(u);
      u.sharingSince = null; u.lunchSince = null; u.lunch = false; u.sharing = false; viewers.delete(socket.id);
    } else {
      u.sharing = true; u.lunch = lunch; u.lunchSince = lunch ? (u.lunchSince || now) : null;
      updateAttendanceSession(u);
    }
    sendTotals(u);
    broadcastEmployees();
  });

  socket.on('watch', arg => {
    const employeeId = typeof arg === 'object' && arg ? arg.id : arg;
    const relay = typeof arg === 'object' && arg ? !!arg.relay : false;
    const admin = me(), target = users.get(employeeId);
    if (admin?.role !== 'admin' || !target?.sharing) return;
    if (!viewers.has(employeeId)) viewers.set(employeeId, new Set());
    viewers.get(employeeId).add(socket.id);
    io.to(employeeId).emit('watch-request', { adminId: socket.id, relay });
    sendViewers(employeeId);
    broadcastEmployees();
  });

  socket.on('unwatch', employeeId => {
    if (me()?.role !== 'admin') return;
    removeViewer(employeeId, socket.id);
    broadcastEmployees();
  });

  const canSignal = (from, to) => {
    const a = users.get(from), b = users.get(to);
    if (!a || !b) return false;
    return (a.role === 'admin' && b.role === 'employee') ||
           (a.role === 'employee' && b.role === 'admin');
  };

  socket.on('webrtc-offer', ({ to, offer }) => canSignal(socket.id, to) && io.to(to).emit('webrtc-offer', { from: socket.id, offer }));
  socket.on('webrtc-answer', ({ to, answer }) => canSignal(socket.id, to) && io.to(to).emit('webrtc-answer', { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => canSignal(socket.id, to) && io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    users.delete(socket.id);
    if (!u) return;
    if (u.role === 'admin') {
      for (const employeeId of [...viewers.keys()]) removeViewer(employeeId, socket.id);
    } else if (u.role === 'employee') {
      flushSession(u);
      viewers.delete(socket.id);
    }
    broadcastEmployees();
  });
});

setInterval(() => {
  let any = false;
  for (const u of users.values()) if (u.role === 'employee' && u.sharing) { updateAttendanceSession(u, false); any = true; }
  if (any) saveAttendance();
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WFH server running on http://localhost:${PORT}`);
  console.log(`Single admin: ${ADMIN_USER}`);
  buildIce().then(r => console.log(r.turn ? 'TURN relay: configured' : `TURN relay: NOT configured (${meteredError || 'no TURN_URLS'}) — remote screen share will fail on strict networks`));
});
