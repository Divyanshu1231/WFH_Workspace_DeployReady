# Local Face Attendance

## Features
- Face-only attendance: employee does NOT enter Employee ID to mark attendance.
- Admin employee registration and face registration.
- Multiple face samples per employee.
- Face recognition across all registered employees.
- Duplicate scan protection for 5 minutes.
- Admin attendance table.
- Export all attendance records to CSV.
- Works on the local LAN using the computer's IP.

## Run on Windows

From the project folder:

```cmd
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open on the PC/mobile on the same Wi-Fi:

```text
http://YOUR-PC-IP:8000/
```

Admin:

```text
http://YOUR-PC-IP:8000/#admin
```

Default admin credentials:

```text
User ID: admin
Password: admin123
```

For mobile camera access on a local HTTP address, Chrome may require the development-only
"Insecure origins treated as secure" setting. For production, use HTTPS instead.

## Attendance flow

1. Admin registers an employee.
2. Admin captures at least 3 face samples.
3. Employee opens the main page.
4. Employee taps Start Camera.
5. Employee taps Scan Face & Mark Attendance.
6. Backend compares the face against registered employee models.
7. Matching employee is identified automatically.
8. Attendance is stored in SQLite.
9. Admin can export all attendance to CSV.

## CSV columns

- Attendance ID
- Employee ID
- Name
- Department
- Date
- Time
- Status
