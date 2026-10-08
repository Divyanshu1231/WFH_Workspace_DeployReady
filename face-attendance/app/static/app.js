
const $ = s => document.querySelector(s);

let admin = { user: "", password: "" };
let stream = null;
let scanning = false;

function page() {
    location.hash === "#admin" ? adminPage() : attendancePage();
}

function stopCamera() {
    scanning = false;

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
}

function attendancePage() {
    stopCamera();

    $("#app").innerHTML = `
        <div class="card attendance-card">
            <div class="hero">
                <span class="badge">FACE RECOGNITION</span>
                <h1>Mark Attendance</h1>
                <p>Your face is enough. No Employee ID is required.</p>
            </div>

            <div class="guide">
                <video id="cam" class="camera" autoplay playsinline muted></video>
            </div>

            <div class="attendance-actions">
                <button id="start">Start Camera</button>
                <button id="mark" disabled>Scan Face & Mark Attendance</button>
            </div>

            <div id="msg" class="status">
                Start the camera and look directly at it.
            </div>
        </div>
    `;

    $("#start").onclick = startCamera;
    $("#mark").onclick = mark;
}

async function startCamera() {
    try {
        stopCamera();

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("Camera API is not available in this browser.");
        }

        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "user" },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        });

        const cam = $("#cam");

        if (!cam) {
            throw new Error("Camera element not found.");
        }

        cam.srcObject = stream;

        await cam.play();

        const markButton = $("#mark");
        if (markButton) markButton.disabled = false;

        const captureButton = $("#capture");
        if (captureButton) captureButton.disabled = false;

        msg(
            "Camera ready. Center your face and tap Scan Face & Mark Attendance.",
            "success"
        );

    } catch (e) {
        console.error("Camera error:", e);

        msg(
            "Camera blocked. Allow camera permission for this site.",
            "error"
        );
    }
}

function msg(text, cls = "status") {
    const el = $("#msg");

    if (!el) return;

    el.className = cls;
    el.textContent = text;
}

function snap() {
    const video = $("#cam");

    if (!video) {
        throw new Error("Camera is not started.");
    }

    if (!video.videoWidth || !video.videoHeight) {
        throw new Error(
            "Camera is not ready yet. Please wait 1-2 seconds."
        );
    }

    const canvas = document.createElement("canvas");

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d");

    ctx.drawImage(
        video,
        0,
        0,
        canvas.width,
        canvas.height
    );

    return canvas.toDataURL("image/jpeg", 0.90);
}

async function mark() {
    if (scanning) return;

    scanning = true;

    const button = $("#mark");

    try {
        if (!stream) {
            throw new Error("Start the camera first.");
        }

        button.disabled = true;
        button.textContent = "Recognizing Face...";

        msg(
            "Looking for a registered employee...",
            "status"
        );

        const image = snap();

        const r = await fetch("/api/attendance", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                image: image
            })
        });

        const d = await r.json();

        if (!r.ok) {
            throw new Error(
                d.detail || "Face recognition failed."
            );
        }

        const employee = d.employee;

        if (d.duplicate) {
            msg(
                `Already marked today: ${employee.name} (${employee.id})`,
                "success"
            );
        } else {
            msg(
                `✓ Attendance marked: ${employee.name} • ${employee.id} • ${formatTime(d.marked_at)}`,
                "success"
            );
        }

    } catch (e) {
        console.error(e);

        msg(
            e.message || "Attendance failed.",
            "error"
        );

    } finally {
        scanning = false;

        if (button) {
            button.disabled = !stream;
            button.textContent = "Scan Face & Mark Attendance";
        }
    }
}

function formatTime(value) {
    try {
        return new Date(value).toLocaleTimeString();
    } catch {
        return value;
    }
}

function adminPage() {
    if (!admin.user) {
        loginPage();
        return;
    }

    dashboard();
}

function loginPage() {
    stopCamera();

    $("#app").innerHTML = `
        <div class="card login-card">

            <div class="hero">
                <span class="badge">ADMIN PANEL</span>
                <h1>Admin Login</h1>
                <p>Manage employees, face registration and attendance.</p>
            </div>

            <input
                id="au"
                placeholder="User ID"
                autocomplete="username"
            >

            <input
                id="ap"
                type="password"
                placeholder="Password"
                autocomplete="current-password"
            >

            <button id="login">Login</button>

            <div id="msg" class="status"></div>

        </div>
    `;

    $("#login").onclick = async () => {

        const user = $("#au").value.trim();
        const password = $("#ap").value;

        if (!user || !password) {
            return msg(
                "Enter User ID and Password.",
                "error"
            );
        }

        try {
            const r = await fetch("/api/admin/login", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    user,
                    password
                })
            });

            if (!r.ok) {
                throw new Error(
                    "Invalid User ID or Password"
                );
            }

            admin = {
                user,
                password
            };

            dashboard();

        } catch (e) {
            msg(e.message, "error");
        }
    };
}

async function dashboard() {

    stopCamera();

    $("#app").innerHTML = `
        <div class="admin-top">
            <div>
                <span class="badge">ADMIN PANEL</span>
                <h1>Attendance Management</h1>
                <p>Register employees and manage face-based attendance.</p>
            </div>

            <button id="logout" class="secondary small-btn">
                Logout
            </button>
        </div>

        <div class="grid">

            <div class="card">

                <h2>Register Employee</h2>

                <p class="muted">
                    Employee ID is used only during registration.
                    Attendance does not require it.
                </p>

                <input
                    id="id"
                    placeholder="Employee ID e.g. EM002"
                >

                <input
                    id="name"
                    placeholder="Full Name"
                >

                <input
                    id="dept"
                    placeholder="Department"
                >

                <button id="reg">
                    Register Employee
                </button>

                <div id="msg" class="status"></div>

            </div>


            <div class="card">

                <h2>Face Registration</h2>

                <select id="emp"></select>

                <div class="guide" style="margin-top:12px">
                    <video
                        id="cam"
                        class="camera"
                        autoplay
                        playsinline
                        muted
                    ></video>
                </div>

                <button id="start">
                    Start Camera
                </button>

                <button id="capture" disabled>
                    Capture Face Sample
                </button>

                <p id="samples" class="sample-count">
                    0 samples
                </p>

                <p class="muted">
                    Capture at least 3 clear samples.
                    5-10 samples from slightly different angles
                    improve recognition.
                </p>

            </div>

        </div>


        <div class="card">

            <div class="row">
                <div>
                    <h2>Today's Attendance</h2>
                    <p class="muted">
                        Face-recognized attendance records for today.
                    </p>
                </div>

                <div class="toolbar">
                    <button id="refresh">
                        Refresh
                    </button>

                    <button id="export" class="export-btn">
                        Export All CSV
                    </button>
                </div>
            </div>

            <div class="table-wrap">
                <table class="table">

                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Name</th>
                            <th>Department</th>
                            <th>Date & Time</th>
                        </tr>
                    </thead>

                    <tbody id="att"></tbody>

                </table>
            </div>

        </div>
    `;

    $("#reg").onclick = register;
    $("#start").onclick = startCamera;
    $("#capture").onclick = capture;
    $("#refresh").onclick = loadAtt;
    $("#export").onclick = exportCSV;
    $("#emp").onchange = loadSampleCount;

    $("#logout").onclick = () => {
        admin = { user: "", password: "" };
        location.hash = "#admin";
        loginPage();
    };

    await loadEmployees();
    await loadAtt();
    await loadSampleCount();
}

async function H(url, opt = {}) {

    opt.headers = {
        ...(opt.headers || {}),
        "X-Admin-User": admin.user,
        "X-Admin-Password": admin.password
    };

    return fetch(url, opt);
}

async function loadEmployees() {

    try {

        const r = await H(
            "/api/admin/employees"
        );

        if (!r.ok) {
            throw new Error(
                "Unable to load employees"
            );
        }

        const es = await r.json();
        const select = $("#emp");

        if (!select) return;

        if (!es.length) {

            select.innerHTML = `
                <option value="">
                    No employees registered
                </option>
            `;

            return;
        }

        select.innerHTML = es.map(e => `
            <option value="${escapeHtml(e.id)}">
                ${escapeHtml(e.id)} — ${escapeHtml(e.name)}
                ${e.face_registered ? " ✓" : " — face pending"}
            </option>
        `).join("");

    } catch (e) {

        console.error(e);

        const select = $("#emp");

        if (select) {
            select.innerHTML = `
                <option value="">
                    Unable to load employees
                </option>
            `;
        }
    }
}

async function loadSampleCount() {

    const id = $("#emp")?.value;

    if (!id) {
        if ($("#samples")) {
            $("#samples").textContent = "0 samples";
        }
        return;
    }

    try {

        const r = await H(
            "/api/admin/employees"
        );

        if (!r.ok) return;

        const employees = await r.json();

        const employee = employees.find(
            e => e.id === id
        );

        if (employee && $("#samples")) {

            $("#samples").textContent =
                `${employee.samples || 0} samples`;
        }

    } catch (e) {
        console.error(e);
    }
}

async function register() {

    const b = {
        id: $("#id").value.trim(),
        name: $("#name").value.trim(),
        department: $("#dept").value.trim()
    };

    if (!b.id || !b.name) {
        return msg(
            "Employee ID and Full Name are required.",
            "error"
        );
    }

    try {

        const r = await H(
            "/api/admin/employees",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(b)
            }
        );

        const d = await r.json();

        if (!r.ok) {
            throw new Error(
                d.detail || "Registration failed"
            );
        }

        msg(
            "Employee registered successfully. Now capture face samples.",
            "success"
        );

        $("#id").value = "";
        $("#name").value = "";
        $("#dept").value = "";

        await loadEmployees();
        await loadSampleCount();

    } catch (e) {

        msg(
            e.message || "Registration failed",
            "error"
        );
    }
}

async function capture() {

    const id = $("#emp")?.value;

    if (!id) {
        return msg(
            "Select an employee first.",
            "error"
        );
    }

    const captureButton = $("#capture");

    try {

        if (!stream) {
            throw new Error(
                "Start Camera first."
            );
        }

        captureButton.disabled = true;
        captureButton.textContent = "Capturing...";

        const image = snap();

        const r = await H(
            `/api/admin/employees/${encodeURIComponent(id)}/face`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    image: image
                })
            }
        );

        const d = await r.json();

        if (!r.ok) {
            throw new Error(
                d.detail || "Face capture failed"
            );
        }

        $("#samples").textContent =
            `${d.samples} sample${d.samples === 1 ? "" : "s"}`;

        if (d.samples >= 3) {

            msg(
                "✓ Face registration complete. Attendance can now be marked by face.",
                "success"
            );

        } else {

            msg(
                `Sample ${d.samples} captured. Capture ${3 - d.samples} more.`,
                "success"
            );
        }

        await loadEmployees();

        await new Promise(resolve =>
            setTimeout(resolve, 400)
        );

    } catch (e) {

        console.error(e);

        msg(
            e.message || "Face capture failed",
            "error"
        );

    } finally {

        if (captureButton) {
            captureButton.disabled = !stream;
            captureButton.textContent =
                "Capture Face Sample";
        }
    }
}

async function loadAtt() {

    try {

        const r = await H(
            "/api/admin/attendance"
        );

        if (!r.ok) {
            throw new Error(
                "Unable to load attendance"
            );
        }

        const rows = await r.json();

        $("#att").innerHTML =
            rows.map(x => `
                <tr>
                    <td>
                        <strong>${escapeHtml(x.employee_id)}</strong>
                    </td>
                    <td>${escapeHtml(x.name)}</td>
                    <td>${escapeHtml(x.department || "-")}</td>
                    <td>${escapeHtml(formatDateTime(x.marked_at))}</td>
                </tr>
            `).join("")
            ||
            `
                <tr>
                    <td colspan="4" class="empty">
                        No attendance yet
                    </td>
                </tr>
            `;

    } catch (e) {

        console.error(e);

        $("#att").innerHTML = `
            <tr>
                <td colspan="4" class="empty">
                    Unable to load attendance
                </td>
            </tr>
        `;
    }
}

async function exportCSV() {

    try {

        const r = await H(
            "/api/admin/attendance/export"
        );

        if (!r.ok) {

            const d = await r.json().catch(() => ({}));

            throw new Error(
                d.detail || "CSV export failed"
            );
        }

        const blob = await r.blob();

        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");

        a.href = url;
        a.download =
            `attendance_export_${new Date().toISOString().slice(0,10)}.csv`;

        document.body.appendChild(a);
        a.click();
        a.remove();

        URL.revokeObjectURL(url);

        msg(
            "Attendance CSV exported successfully.",
            "success"
        );

    } catch (e) {

        console.error(e);

        msg(
            e.message || "CSV export failed.",
            "error"
        );
    }
}

function formatDateTime(value) {

    try {
        return new Date(value).toLocaleString();
    } catch {
        return value;
    }
}

function escapeHtml(value) {

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

window.addEventListener(
    "hashchange",
    page
);

page();
