
import os, sqlite3, base64, csv, io
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
FACES = DATA / "faces"
DATA.mkdir(exist_ok=True)
FACES.mkdir(exist_ok=True)

DB = DATA / "attendance.db"
ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

app = FastAPI(title="Local Face Attendance")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

face_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)


def db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    con = db()
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS employees(
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            department TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS attendance(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id TEXT NOT NULL,
            marked_at TEXT NOT NULL,
            FOREIGN KEY(employee_id) REFERENCES employees(id)
        );
        """
    )
    con.commit()
    con.close()


init_db()


def decode_data(data):
    if not data:
        raise HTTPException(400, "No camera image received")

    try:
        if "," in data:
            data = data.split(",", 1)[1]
        arr = np.frombuffer(base64.b64decode(data), np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError
        return img
    except Exception:
        raise HTTPException(400, "Invalid camera image")


def largest_face(img):
    if img is None:
        return None

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    faces = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.15,
        minNeighbors=5,
        minSize=(100, 100),
    )

    if len(faces) == 0:
        return None

    x, y, w, h = max(faces, key=lambda z: z[2] * z[3])

    pad = int(min(w, h) * 0.15)

    x = max(0, x - pad)
    y = max(0, y - pad)
    w = min(img.shape[1] - x, w + 2 * pad)
    h = min(img.shape[0] - y, h + 2 * pad)

    return gray[y:y + h, x:x + w]


def train_employee(emp_id):
    if not hasattr(cv2, 'face') or not hasattr(cv2.face, 'LBPHFaceRecognizer_create'):
        raise RuntimeError('OpenCV Face module is missing. Install opencv-contrib-python and remove opencv-python from this environment.')
    folder = FACES / emp_id
    imgs = []

    for p in folder.glob("*.jpg"):
        im = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
        if im is not None:
            imgs.append(im)

    if len(imgs) < 3:
        raise ValueError("At least 3 face samples required")

    recognizer = cv2.face.LBPHFaceRecognizer_create(
        radius=1,
        neighbors=8,
        grid_x=8,
        grid_y=8,
    )

    recognizer.train(
        imgs,
        np.array([1] * len(imgs))
    )

    recognizer.write(str(folder / "model.yml"))


def auth(request: Request):
    if (
        request.headers.get("X-Admin-User") == ADMIN_USER
        and request.headers.get("X-Admin-Password") == ADMIN_PASSWORD
    ):
        return True

    raise HTTPException(401, "Invalid admin credentials")


def recognize_employee(face):
    """
    Compare the captured face against every registered employee model.
    Returns the best matching employee and LBPH confidence.
    Lower confidence = better match.
    """
    con = db()
    employees = con.execute(
        "SELECT * FROM employees ORDER BY id"
    ).fetchall()
    con.close()

    best_employee = None
    best_confidence = None

    probe = cv2.resize(face, (200, 200))

    for emp in employees:
        model_path = FACES / emp["id"] / "model.yml"

        if not model_path.exists():
            continue

        try:
            recognizer = cv2.face.LBPHFaceRecognizer_create(
                radius=1,
                neighbors=8,
                grid_x=8,
                grid_y=8,
            )
            recognizer.read(str(model_path))

            _, confidence = recognizer.predict(probe)
            confidence = float(confidence)

            if best_confidence is None or confidence < best_confidence:
                best_confidence = confidence
                best_employee = emp

        except Exception:
            continue

    if best_employee is None:
        return None, None

    return best_employee, best_confidence


@app.get("/")
def index():
    return FileResponse(ROOT / "app/static/index.html")


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "time": datetime.now().isoformat(timespec="seconds"),
        "lbph_available": bool(hasattr(cv2, 'face') and hasattr(cv2.face, 'LBPHFaceRecognizer_create')),
    }


@app.post("/api/admin/login")
async def admin_login(request: Request):
    b = await request.json()

    if (
        b.get("user") == ADMIN_USER
        and b.get("password") == ADMIN_PASSWORD
    ):
        return {"ok": True}

    raise HTTPException(401, "Invalid User ID or Password")


@app.get("/api/admin/employees")
def employees(request: Request):
    auth(request)

    con = db()
    rows = con.execute(
        "SELECT * FROM employees ORDER BY name"
    ).fetchall()
    con.close()

    result = []

    for row in rows:
        item = dict(row)
        folder = FACES / row["id"]
        item["samples"] = len(list(folder.glob("*.jpg"))) if folder.exists() else 0
        item["face_registered"] = (folder / "model.yml").exists()
        result.append(item)

    return result


@app.post("/api/admin/employees")
async def add_employee(request: Request):
    auth(request)

    b = await request.json()

    emp_id = b.get("id", "").strip()
    name = b.get("name", "").strip()
    dept = b.get("department", "").strip()

    if not emp_id or not name:
        raise HTTPException(
            400,
            "Employee ID and name are required"
        )

    con = db()

    try:
        con.execute(
            "INSERT INTO employees VALUES(?,?,?,?)",
            (
                emp_id,
                name,
                dept,
                datetime.now().isoformat(timespec="seconds"),
            ),
        )
        con.commit()

    except sqlite3.IntegrityError:
        raise HTTPException(
            409,
            "Employee ID already exists"
        )

    finally:
        con.close()

    (FACES / emp_id).mkdir(exist_ok=True)

    return {"ok": True}


@app.post("/api/admin/employees/{emp_id}/face")
async def add_face(emp_id: str, request: Request):
    auth(request)
    if not hasattr(cv2, 'face') or not hasattr(cv2.face, 'LBPHFaceRecognizer_create'):
        raise HTTPException(500, 'OpenCV Face module is missing. Run: pip uninstall opencv-python -y && pip install --upgrade opencv-contrib-python')

    con = db()
    exists = con.execute(
        "SELECT id FROM employees WHERE id=?",
        (emp_id,),
    ).fetchone()
    con.close()

    if not exists:
        raise HTTPException(
            404,
            "Employee not found"
        )

    b = await request.json()
    img = decode_data(b.get("image", ""))

    face = largest_face(img)

    if face is None:
        raise HTTPException(
            400,
            "No clear face detected. Keep your face inside the guide."
        )

    folder = FACES / emp_id
    folder.mkdir(exist_ok=True)

    existing = sorted(folder.glob("*.jpg"))
    n = len(existing)

    filename = folder / f"{n + 1:03d}.jpg"

    cv2.imwrite(
        str(filename),
        cv2.resize(face, (200, 200)),
    )

    sample_count = n + 1

    if sample_count >= 3:
        train_employee(emp_id)

    return {
        "ok": True,
        "samples": sample_count,
        "face_registered": sample_count >= 3,
    }


@app.post("/api/attendance")
async def attendance(request: Request):
    """
    Face-only attendance:
    Employee ID is NOT required from the user.
    The backend compares the captured face with every registered employee.
    """
    b = await request.json()

    img = decode_data(b.get("image", ""))
    face = largest_face(img)

    if face is None:
        raise HTTPException(
            400,
            "Face not detected. Keep your face inside the guide."
        )

    employee, confidence = recognize_employee(face)

    if employee is None:
        raise HTTPException(
            404,
            "No employee has a completed face registration yet."
        )

    expected_name = str(b.get("expected_name", "")).strip()
    if expected_name and employee["name"].strip().casefold() != expected_name.casefold():
        raise HTTPException(
            403,
            f"Face does not match the entered employee name: {expected_name}"
        )

    # LBPH: lower confidence is a better match.
    MATCH_THRESHOLD = 65.0

    if confidence > MATCH_THRESHOLD:
        raise HTTPException(
            403,
            "Face not recognized. Please look at the camera clearly."
        )

    now = datetime.now()

    con = db()

    recent = con.execute(
        """
        SELECT marked_at
        FROM attendance
        WHERE employee_id=?
        ORDER BY id DESC
        LIMIT 1
        """,
        (employee["id"],),
    ).fetchone()

    if recent:
        try:
            last = datetime.fromisoformat(
                recent["marked_at"]
            )

            # Prevent repeated scans within 5 minutes.
            if (now - last).total_seconds() < 300:
                con.close()

                return {
                    "ok": True,
                    "duplicate": True,
                    "employee": dict(employee),
                    "marked_at": recent["marked_at"],
                    "confidence": round(confidence, 1),
                }

        except Exception:
            pass

    ts = now.isoformat(timespec="seconds")

    con.execute(
        """
        INSERT INTO attendance(employee_id, marked_at)
        VALUES(?,?)
        """,
        (
            employee["id"],
            ts,
        ),
    )

    con.commit()
    con.close()

    return {
        "ok": True,
        "duplicate": False,
        "employee": dict(employee),
        "marked_at": ts,
        "confidence": round(confidence, 1),
    }


@app.get("/api/admin/attendance")
def attendance_list(request: Request):
    auth(request)

    con = db()

    rows = con.execute(
        """
        SELECT
            a.id,
            a.employee_id,
            e.name,
            e.department,
            a.marked_at
        FROM attendance a
        JOIN employees e
            ON e.id = a.employee_id
        WHERE date(a.marked_at)=date('now','localtime')
        ORDER BY a.id DESC
        """
    ).fetchall()

    con.close()

    return [dict(x) for x in rows]


@app.get("/api/admin/attendance/export")
def export_attendance(request: Request):
    """
    Export ALL attendance records as CSV.
    """
    auth(request)

    con = db()

    rows = con.execute(
        """
        SELECT
            a.id,
            a.employee_id,
            e.name,
            e.department,
            a.marked_at
        FROM attendance a
        JOIN employees e
            ON e.id = a.employee_id
        ORDER BY a.marked_at DESC, a.id DESC
        """
    ).fetchall()

    con.close()

    output = io.StringIO(newline="")
    writer = csv.writer(output)

    writer.writerow(
        [
            "Attendance ID",
            "Employee ID",
            "Name",
            "Department",
            "Date",
            "Time",
            "Status",
        ]
    )

    for row in rows:
        marked_at = row["marked_at"]

        try:
            dt = datetime.fromisoformat(marked_at)
            date_value = dt.strftime("%Y-%m-%d")
            time_value = dt.strftime("%H:%M:%S")
        except Exception:
            date_value = marked_at[:10]
            time_value = marked_at[11:19]

        writer.writerow(
            [
                row["id"],
                row["employee_id"],
                row["name"],
                row["department"] or "",
                date_value,
                time_value,
                "Present",
            ]
        )

    content = output.getvalue()
    output.close()

    filename = (
        f"attendance_export_"
        f"{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    )

    return StreamingResponse(
        iter([content.encode("utf-8-sig")]),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        },
    )


app.mount(
    "/static",
    StaticFiles(directory=ROOT / "app/static"),
    name="static",
)
