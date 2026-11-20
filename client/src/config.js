// Dev: server runs on port 4000 of the same host. Prod: client is served by the server itself.
export const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ||
  (import.meta.env.PROD ? window.location.origin : `${window.location.protocol}//${window.location.hostname}:4000`);

// Mutable on purpose: loadIceServers() fills in TURN from the server at runtime.
export const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// Build-time fallback (optional): VITE_TURN_URL / VITE_TURN_USER / VITE_TURN_PASS
if (import.meta.env.VITE_TURN_URL) {
  RTC_CONFIG.iceServers.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USER,
    credential: import.meta.env.VITE_TURN_PASS,
  });
}

export const iceInfo = { turn: !!import.meta.env.VITE_TURN_URL };

// Preferred: the server hands out ICE/TURN settings (Metered), so changing them only needs a server env change.
let iceLoadedAt = 0;
export async function loadIceServers({ force = false } = {}) {
  // Credentials are re-fetched at most every 4 minutes, but always before a new screen-share connection.
  if (!force && iceLoadedAt && Date.now() - iceLoadedAt < 4 * 60 * 1000) return iceInfo.turn;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${SERVER_URL}/api/ice`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const { iceServers, turn } = await res.json();
        if (Array.isArray(iceServers) && iceServers.length) {
          RTC_CONFIG.iceServers = iceServers;
          iceInfo.turn = !!turn;
          iceLoadedAt = Date.now();
          return iceInfo.turn;
        }
      }
    } catch { /* server may be waking up (Render free tier) - retry */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  return iceInfo.turn;
}


// Face attendance service URL. Priority: URL saved in the Admin screen > server FACE_API_URL env > build-time VITE_FACE_API_URL > default.
const DEFAULT_FACE_API_URL = import.meta.env.PROD
  ? 'https://wfh-face-attendance.onrender.com'
  : `${window.location.protocol}//${window.location.hostname}:8000`;

export const cleanFaceUrl = u => {
  let x = String(u || '').trim().replace(/\/+$/, '');
  if (!x) return '';
  if (!/^https?:\/\//i.test(x)) x = `https://${x}`;
  if (/\.onrender\.com/i.test(x)) x = x.replace(/:\d+$/, ''); // never :8000 on Render
  return x;
};

const FACE_KEY = 'wfh-face-url';
const stored = (() => { try { return localStorage.getItem(FACE_KEY) || ''; } catch { return ''; } })();
export let FACE_API_URL = cleanFaceUrl(stored || import.meta.env.VITE_FACE_API_URL || DEFAULT_FACE_API_URL);

export function setFaceApiUrl(u) {
  const v = cleanFaceUrl(u);
  try { v ? localStorage.setItem(FACE_KEY, v) : localStorage.removeItem(FACE_KEY); } catch { /* ignore */ }
  FACE_API_URL = v || cleanFaceUrl(import.meta.env.VITE_FACE_API_URL || DEFAULT_FACE_API_URL);
  return FACE_API_URL;
}

// Attendance mode comes from the server: "simple" (name based, no Python service) or "face".
let attendanceMode = stored ? 'face' : 'simple';
export const getAttendanceMode = () => attendanceMode;
let configPromise = null;
export function loadServerConfig() {
  if (!configPromise) {
    configPromise = (async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/config`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const { faceApiUrl, mode } = await r.json();
        if (mode) attendanceMode = stored ? 'face' : mode;
        if (faceApiUrl && !stored) FACE_API_URL = cleanFaceUrl(faceApiUrl);
      } catch { /* keep defaults */ }
    })();
  }
  return configPromise;
}

// Explains WHY the face service cannot be reached (wrong URL vs sleeping vs crashed).
export async function testFaceService(url = FACE_API_URL, timeoutMs = 70000) {
  try {
    const r = await fetch(`${url}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    if (r.ok && j?.lbph_available === true) return { ok: true, msg: '✓ Face service online and face module OK.' };
    if (r.ok && j && 'uptime' in j && !('lbph_available' in j)) return { ok: false, msg: '❌ Ye URL WFH Node app ka hai (wfh-workspace), face service ka nahi. Face ke liye alag Python web service banani padegi (Root Directory: face-attendance) aur uska URL yahan daalna hai.' };
    if (r.ok && j) return { ok: false, msg: 'Service chal rahi hai lekin OpenCV face module missing hai (requirements me opencv-contrib-python-headless chahiye).' };
    if (r.status === 404) return { ok: false, msg: 'HTTP 404: ye URL kisi aur service ka hai ya service exist nahi karti. Render dashboard se Python service ka sahi URL copy karo.' };
    if (r.status >= 500) return { ok: false, msg: `HTTP ${r.status}: service start to hui par crash ho rahi hai. Render → wfh-face-attendance → Logs dekho.` };
    return { ok: false, msg: `HTTP ${r.status} mila — ye face service ka URL nahi lagta.` };
  } catch (e) {
    if (e?.name === 'TimeoutError') return { ok: false, msg: 'Timeout: service 70 sec me nahi jagi. Render Logs me deploy error dekho.' };
    return { ok: false, msg: 'Server tak pahunch hi nahi paaya: URL galat hai, service exist nahi karti, ya deploy fail hai (browser me wahi URL/api/health kholke dekho).' };
  }
}

// Render free services sleep after ~15 min idle and need up to ~60-90s to wake up.
// faceFetch pings /api/health until the face service answers, then retries the request once.
export async function wakeFaceService(maxMs = 90000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${FACE_API_URL}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && 'lbph_available' in j) return true;   // real face service
      if (r.ok && j && 'uptime' in j) return false;          // this is the Node WFH app, not the face service
    } catch { /* still waking up */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

export async function faceFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    if (await wakeFaceService()) return fetch(url, opts);
    throw err;
  }
}
