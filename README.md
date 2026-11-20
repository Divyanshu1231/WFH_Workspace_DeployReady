# WFH Workspace — Face Attendance + Live Screen Sharing

This version uses **one Admin** and keeps the existing live screen-sharing/WebRTC setup. The multiple-admin/Super-Admin workflow is removed.

## Final employee flow
1. Admin registers the employee with **Employee ID + Name + optional Department**.
2. Admin captures **3 face samples** for that employee from **Admin → Register Employee**.
3. Employee opens the Employee screen and clicks **Scan Face & Mark Attendance**.
4. The system recognizes the employee **from the face only** — no employee name/ID needs to be typed at attendance time.
5. Attendance is recorded in SQLite.
6. The app attempts to start screen sharing. If the browser blocks the automatic prompt, the employee gets a **Start Screen Share** button.
7. Admin can open **Live Employees** and click **View Live Screen** for any employee who is sharing.
8. Employee can start a **1-hour Lunch Break**. The work timer stops and the shared video pauses. After one hour, **Resume Work** becomes available and both resume.
9. Admin → **Attendance & CSV** shows today's records and **Export All CSV** downloads every attendance record stored in the database.

## Admin login
Default:
- Username: `admin`
- Password: `admin123`

For production, set `ADMIN_USER` and `ADMIN_PASSWORD` in the server environment. The same credentials are used for the face-attendance admin API.

## Start face service (Python 3.12 recommended)

```bash
cd face-attendance
python -m venv venv
venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The face service uses OpenCV LBPH and requires `opencv-contrib-python` from `requirements.txt`.

## Start WFH app

```bash
npm install
npm --prefix server install
npm --prefix client install
npm --prefix client run build
```

Then start the server:

PowerShell:
```powershell
$env:ADMIN_USER="admin"
$env:ADMIN_PASSWORD="admin123"
npm --prefix server start
```

The WFH server uses port `4000`; the face service uses port `8000`.

## Face API URL
Local default:

`http://localhost:8000`

For Render production, the app defaults to:

`https://wfh-face-attendance.onrender.com`

If your Render face service uses a different URL, set `VITE_FACE_API_URL` in the WFH Render service and redeploy. Do not append `:8000` to a Render HTTPS URL.

## HTTPS
Screen sharing on another device requires HTTPS. `localhost` works for local development.

## TURN (Metered) — required for remote employees
Employees working from home sit behind different routers/NATs, so a direct connection to the admin often fails. A TURN relay fixes this.

1. Create a free app at https://www.metered.ca → **TURN Server** → note your **app domain** (e.g. `yourapp.metered.live`) and **API key**.
2. In the Render **wfh-workspace** service → Environment, set:
   - `METERED_DOMAIN` = `yourapp.metered.live` (no `https://`)
   - `METERED_API_KEY` = your API key
3. Redeploy (Manual Deploy → Deploy latest commit). No client rebuild is needed; the server hands TURN credentials to the browsers.
4. Verify: open `https://<your-wfh-app>.onrender.com/api/ice-check` → it must show `"turn": true` and `relayServers` > 0. The Admin header also shows **🌐 TURN relay ON**.

How the app uses it: the first attempt is a normal WebRTC connection; if it fails (or hangs for 12s) the admin page automatically retries **relay-only** through Metered. The **Retry (via relay)** button forces relay mode.

Alternative: `TURN_URLS`, `TURN_USER`, `TURN_PASS` for your own TURN server (e.g. coturn).

## Fixed employee registration / camera flow

After **Create Employee**, the admin page now opens a visible face camera automatically. Capture one sample at a time until **3/3**. The camera can also be opened manually if the automatic permission prompt was blocked.

If the camera does not open:
- Use Chrome/Edge.
- For local use, open the WFH app with `http://localhost:4000` (not a raw LAN `http://192.168.x.x` URL).
- For another computer/device, use HTTPS; browser camera APIs require a secure context.
- Allow Camera permission from the browser address-bar camera icon.

If face capture reports that the OpenCV Face module is missing, inside `face-attendance` activate the Python 3.12 venv and run:

```bash
pip uninstall opencv-python opencv-contrib-python -y
pip install -r requirements.txt
```

The face service health endpoint is `http://localhost:8000/api/health`. It should report `"lbph_available": true`.


## Render deployment
The face-recognition API is a separate Render web service. Do NOT append `:8000` to its public Render URL. Render supplies the public HTTPS port automatically. The Node WFH service uses `VITE_FACE_API_URL=https://wfh-face-attendance.onrender.com`.

If the face service is deployed under a different Render service name, update `VITE_FACE_API_URL` in the WFH service environment and trigger a new deploy because Vite embeds this value during the client build.


## "Face service is not reachable" on Render — checklist
1. Open `https://<face-service-url>/api/health` in a browser. It must return JSON with `"lbph_available": true`. (First open after idle can take 60-90 s on the free plan; the app now waits and retries automatically.)
2. The URL must be the **exact** public URL of the Python service shown in Render (if the name `wfh-face-attendance` was taken, Render adds a suffix, e.g. `wfh-face-attendance-x1y2.onrender.com`). Put that in `VITE_FACE_API_URL` on the **wfh-workspace** service and redeploy (Vite embeds it at build time).
3. If the face service shows "Deploy failed"/crash in Render logs with `libGL.so.1`, the fix is already applied: `requirements.txt` uses `opencv-contrib-python-headless`.
4. Python is pinned to 3.12.7 via `PYTHON_VERSION` in `render.yaml`.


## Simple mode (default) — no Python face service needed
If `FACE_API_URL` is NOT set on the Node service, the app runs in **simple mode**:
employee enters name (+ optional ID) → attendance is saved by the Node server → screen sharing starts immediately → admin sees the screen automatically.
Only the Node service is required (plus Metered TURN for remote employees).

To use face recognition instead, deploy the Python service and set `FACE_API_URL` on the Node service (or `ATTENDANCE_MODE=simple` to force simple mode).
Attendance is stored in `server/attendance.json` (Render free disk is temporary; use a persistent disk or set `ATTENDANCE_FILE` to a disk path).
