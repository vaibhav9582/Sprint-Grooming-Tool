# -*- coding: utf-8 -*-
import os
import asyncio
import urllib.request
import json
import base64
import smtplib
import secrets
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
# pyrefly: ignore [missing-import]
import socketio

# Initialize FastAPI App
app = FastAPI(title="Sprint Grooming Backend")

# Configure CORS for standard REST endpoints (if any)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/api/jira/sprint")
async def get_jira_sprint_issues(data: dict):
    host = data.get("host", "").strip()
    email = data.get("email", "").strip()
    token = data.get("token", "").strip()
    sprint_id = data.get("sprintId", "").strip()
    is_demo = data.get("isDemo", True)

    if is_demo:
        # Return mock issues for demo mode
        mock_issues = [
            {
                "id": "JIRA-101",
                "title": "Auth Service Integration",
                "desc": "Implement OAuth2 authentication flow and connect to the user database.",
                "priority": 5
            },
            {
                "id": "JIRA-102",
                "title": "Database Optimization",
                "desc": "Optimize PostgreSQL indexes for high-frequency queries on the transaction log table.",
                "priority": 3
            },
            {
                "id": "JIRA-103",
                "title": "Docker Setup",
                "desc": "Containerize the FastAPI backend and Angular frontend for production deployment.",
                "priority": 2
            }
        ]
        return {"success": True, "issues": mock_issues}

    # Real Jira API Call
    try:
        if not host.startswith("http://") and not host.startswith("https://"):
            host = "https://" + host
        
        host = host.rstrip("/")
        url = f"{host}/rest/agile/1.0/sprint/{sprint_id}/issue"
        
        auth_str = f"{email}:{token}"
        auth_bytes = auth_str.encode("utf-8")
        auth_b64 = base64.b64encode(auth_bytes).decode("utf-8")
        
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Basic {auth_b64}",
                "Accept": "application/json"
            },
            method="GET"
        )
        
        loop = asyncio.get_event_loop()
        def fetch_url():
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.read()
                
        resp_data = await loop.run_in_executor(None, fetch_url)
        json_resp = json.loads(resp_data.decode("utf-8"))
        
        issues = []
        for item in json_resp.get("issues", []):
            issue_id = item.get("key", "")
            fields = item.get("fields", {})
            title = fields.get("summary", "")
            
            desc = ""
            raw_desc = fields.get("description", "")
            if isinstance(raw_desc, dict):
                try:
                    text_parts = []
                    def extract_text(node):
                        if node.get("type") == "text":
                            text_parts.append(node.get("text", ""))
                        for child in node.get("content", []):
                            extract_text(child)
                    extract_text(raw_desc)
                    desc = "".join(text_parts)
                except Exception:
                    desc = str(raw_desc)
            else:
                desc = str(raw_desc) if raw_desc else ""

            # Map Jira priority name -> numeric 1..5 (default 1 if missing/unknown)
            priority_val = 1
            try:
                raw_priority = fields.get("priority")
                if isinstance(raw_priority, dict):
                    p_name = (raw_priority.get("name") or "").strip().lower()
                    priority_map = {
                        "lowest": 1,
                        "low": 2,
                        "medium": 3,
                        "high": 4,
                        "highest": 5,
                        "critical": 5,
                        "blocker": 5,
                        "trivial": 1,
                        "minor": 2,
                        "major": 4,
                    }
                    priority_val = priority_map.get(p_name, 1)
            except Exception:
                priority_val = 1

            issues.append({
                "id": issue_id,
                "title": title,
                "desc": desc,
                "priority": priority_val
            })
            
        return {"success": True, "issues": issues}
        
    except Exception as e:
        return {"success": False, "error": str(e)}


# Initialize Socket.io AsyncServer
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

# In-memory Room State
rooms = {}
room_timeouts = {}
user_disconnect_timeouts = {}


# ----- Scheduled session window helpers -----
def parse_iso(value):
    """Parse an ISO datetime string (UTC, optionally ending in 'Z') into an
    aware datetime. Returns None if the value is empty or unparseable."""
    if not value:
        return None
    try:
        s = str(value).strip()
        if s.endswith('Z'):
            s = s[:-1] + '+00:00'
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def compute_expires_at(voting_start_at, voting_end_at):
    """Session stays accessible until the selected voting end date, or 2 days
    after the voting start date when no end date is provided."""
    start = parse_iso(voting_start_at)
    end = parse_iso(voting_end_at)
    if end:
        return end.isoformat()
    if start:
        return (start + timedelta(days=2)).isoformat()
    return None


# Load .env file manually if it exists (avoids installing python-dotenv)
_env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(_env_path):
    with open(_env_path, "r", encoding="utf-8") as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _key, _val = _line.split("=", 1)
                os.environ[_key.strip()] = _val.strip()

# SMTP Email Settings (Free notifications support)
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER)

def send_email_sync(to_email: str, subject: str, html_content: str):
    if not SMTP_HOST or not SMTP_USER or not SMTP_PASSWORD:
        print(f"\n[SMTP NOT CONFIGURED - DEMO MODE]")
        print(f"Recipient: {to_email}")
        print(f"Subject: {subject}")
        print(f"HTML Content:\n{html_content}\n")
        return False
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = SMTP_FROM
        msg["To"] = to_email

        part = MIMEText(html_content, "html")
        msg.attach(part)

        if SMTP_PORT == 465:
            server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=10)
        else:
            server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10)
            server.ehlo()
            server.starttls()
            server.ehlo()

        server.login(SMTP_USER, SMTP_PASSWORD)
        server.sendmail(SMTP_FROM, to_email, msg.as_string())
        server.quit()
        print(f"Email successfully sent to {to_email}")
        return True
    except Exception as e:
        print(f"Failed to send email to {to_email}: {e}")
        return False

async def send_email(to_email: str, subject: str, html_content: str):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, send_email_sync, to_email, subject, html_content)

def format_to_12hr(display_str):
    if not display_str:
        return display_str
    try:
        parts = display_str.split(' ')
        if len(parts) >= 3:
            date_part = parts[0]
            time_part = parts[1]
            tz_part = ' '.join(parts[2:])
            
            # If it's already in 12hr format (contains AM/PM), skip it
            if "AM" in tz_part or "PM" in tz_part or "AM" in display_str or "PM" in display_str:
                return display_str
                
            time_parts = time_part.split(':')
            hours = int(time_parts[0])
            minutes = int(time_parts[1])
            
            ampm = "PM" if hours >= 12 else "AM"
            hours = hours % 12
            if hours == 0:
                hours = 12
            
            return f"{date_part} {hours:02d}:{minutes:02d} {ampm} {tz_part}"
    except Exception:
        pass
    return display_str

async def send_scheduling_confirmation(room_id, admin_email, session_name, voting_start_at, voting_end_at, expires_at, frontend_url, admin_token, voting_start_display=None, voting_end_display=None):
    subject = f"🗳️ Voting Session Scheduled: {session_name}"
    join_link = f"{frontend_url}/join/{room_id}?adminToken={admin_token}"
    
    start_dt = parse_iso(voting_start_at)
    end_dt = parse_iso(voting_end_at)
    
    start_str = format_to_12hr(voting_start_display) or (start_dt.strftime('%Y-%m-%d %H:%M UTC') if start_dt else "Immediately")
    end_str = format_to_12hr(voting_end_display) or (end_dt.strftime('%Y-%m-%d %H:%M UTC') if end_dt else "2 days after start")
    html_content = f"""
    <html>
    <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; color: #1e293b; padding: 24px; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);">
            <div style="text-align: center; margin-bottom: 24px;">
                <span style="font-size: 24px; font-weight: 800; color: #fb4e0b;">Sprint Grooming Tool</span>
            </div>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin-bottom: 24px;" />
            <h2 style="font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px;">🗳️ Voting Session Scheduled</h2>
            <p style="font-size: 14px; color: #475569; line-height: 1.6; margin-bottom: 20px;">
                Your sprint grooming session <strong>{session_name}</strong> has been successfully created. We will send you another email when the voting window starts!
            </p>
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 24px 0;">
                <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 600; color: #fb4e0b; width: 140px;">Room / Session ID:</td>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 700; color: #0f172a; font-family: monospace;">{room_id}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 600; color: #fb4e0b;">Session Name:</td>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 500; color: #334155;">{session_name}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 600; color: #fb4e0b;">Voting Opens:</td>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 500; color: #334155;">{start_str}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 600; color: #fb4e0b;">Voting Closes:</td>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 500; color: #334155;">{end_str}</td>
                    </tr>
                </table>
            </div>
            <p style="font-size: 13px; color: #475569; line-height: 1.6;">
                Use the button below to join the room now, manage the backlog, and copy the invite link for other estimators.
            </p>
            <div style="text-align: center; margin-top: 32px; margin-bottom: 16px;">
                <a href="{join_link}" style="background-color: #fb4e0b; color: #ffffff; padding: 12px 28px; border-radius: 8px; font-weight: 700; text-decoration: none; display: inline-block; font-size: 14px; box-shadow: 0 4px 6px -1px rgba(251, 78, 11, 0.2);">Join Grooming Session</a>
            </div>
            <p style="font-size: 11px; color: #94a3b8; text-align: center; margin-top: 32px; margin-bottom: 0;">
                This email was sent by your Sprint Grooming Server.
            </p>
        </div>
    </body>
    </html>
    """
    success = await send_email(admin_email, subject, html_content)
    await sio.emit('email-sent', {'type': 'confirmation', 'email': admin_email, 'success': success}, room=room_id)

async def send_voting_reminder(room_id, admin_email, session_name, voting_start_at, frontend_url, admin_token, voting_start_display=None):
    subject = f"🔔 Voting has Started: {session_name}"
    join_link = f"{frontend_url}/join/{room_id}?adminToken={admin_token}"
    
    start_dt = parse_iso(voting_start_at)
    start_str = format_to_12hr(voting_start_display) or (start_dt.strftime('%Y-%m-%d %H:%M UTC') if start_dt else "now")
    
    html_content = f"""
    <html>
    <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; color: #1e293b; padding: 24px; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);">
            <div style="text-align: center; margin-bottom: 24px;">
                <span style="font-size: 24px; font-weight: 800; color: #fb4e0b;">Sprint Grooming Tool</span>
            </div>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin-bottom: 24px;" />
            <h2 style="font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px;">🔔 It's Time to Vote!</h2>
            <p style="font-size: 14px; color: #475569; line-height: 1.6; margin-bottom: 20px;">
                The scheduled voting time for your sprint grooming session, <strong>{session_name}</strong>, has arrived. Click below to join and launch card estimations.
            </p>
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 24px 0;">
                <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 600; color: #fb4e0b; width: 140px;">Room / Session ID:</td>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 700; color: #0f172a; font-family: monospace;">{room_id}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 600; color: #fb4e0b;">Session Name:</td>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 500; color: #334155;">{session_name}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 600; color: #fb4e0b;">Start Time:</td>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 500; color: #334155;">{start_str}</td>
                    </tr>
                </table>
            </div>
            <div style="text-align: center; margin-top: 32px; margin-bottom: 16px;">
                <a href="{join_link}" style="background-color: #fb4e0b; color: #ffffff; padding: 12px 28px; border-radius: 8px; font-weight: 700; text-decoration: none; display: inline-block; font-size: 14px; box-shadow: 0 4px 6px -1px rgba(251, 78, 11, 0.2);">Go to Voting Room</a>
            </div>
            <p style="font-size: 11px; color: #94a3b8; text-align: center; margin-top: 32px; margin-bottom: 0;">
                This is a scheduled automated reminder from your Sprint Grooming Server.
            </p>
        </div>
    </body>
    </html>
    """
    success = await send_email(admin_email, subject, html_content)
    await sio.emit('email-sent', {'type': 'reminder', 'email': admin_email, 'success': success}, room=room_id)

async def send_voting_reminder_delayed(room_id, admin_email, session_name, voting_start_at, frontend_url, admin_token, voting_start_display=None):
    try:
        start_dt = parse_iso(voting_start_at)
        if not start_dt:
            return
        
        delay = (start_dt - datetime.now(timezone.utc)).total_seconds()
        if delay > 0:
            print(f"Delaying voting reminder for room {room_id} by {delay:.1f} seconds...")
            await asyncio.sleep(delay)
        
        if room_id in rooms and not rooms[room_id].get('sessionClosed'):
            await send_voting_reminder(room_id, admin_email, session_name, voting_start_at, frontend_url, admin_token, voting_start_display)
    except asyncio.CancelledError:
        print(f"Scheduled voting reminder for room {room_id} was cancelled.")
        pass

async def send_voting_pre_reminder(room_id, admin_email, session_name, voting_start_at, frontend_url, admin_token, voting_start_display=None):
    subject = f"⏳ Voting Starts in 15 Minutes: {session_name}"
    join_link = f"{frontend_url}/join/{room_id}?adminToken={admin_token}"
    
    start_dt = parse_iso(voting_start_at)
    start_str = format_to_12hr(voting_start_display) or (start_dt.strftime('%Y-%m-%d %H:%M UTC') if start_dt else "now")
    
    html_content = f"""
    <html>
    <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f8fafc; color: #1e293b; padding: 24px; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);">
            <div style="text-align: center; margin-bottom: 24px;">
                <span style="font-size: 24px; font-weight: 800; color: #fb4e0b;">Sprint Grooming Tool</span>
            </div>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin-bottom: 24px;" />
            <h2 style="font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px;">⏳ Voting Starts in 15 Minutes</h2>
            <p style="font-size: 14px; color: #475569; line-height: 1.6; margin-bottom: 20px;">
                This is a quick reminder that your sprint grooming session, <strong>{session_name}</strong>, is scheduled to start voting in 15 minutes. Get ready and join the room!
            </p>
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 24px 0;">
                <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 600; color: #fb4e0b; width: 140px;">Room / Session ID:</td>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 700; color: #0f172a; font-family: monospace;">{room_id}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 600; color: #fb4e0b;">Session Name:</td>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 500; color: #334155;">{session_name}</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 600; color: #fb4e0b;">Start Time:</td>
                        <td style="padding: 6px 0; font-size: 13px; font-weight: 500; color: #334155;">{start_str}</td>
                    </tr>
                </table>
            </div>
            <div style="text-align: center; margin-top: 32px; margin-bottom: 16px;">
                <a href="{join_link}" style="background-color: #fb4e0b; color: #ffffff; padding: 12px 28px; border-radius: 8px; font-weight: 700; text-decoration: none; display: inline-block; font-size: 14px; box-shadow: 0 4px 6px -1px rgba(251, 78, 11, 0.2);">Go to Voting Room</a>
            </div>
            <p style="font-size: 11px; color: #94a3b8; text-align: center; margin-top: 32px; margin-bottom: 0;">
                This is a scheduled pre-voting reminder from your Sprint Grooming Server.
            </p>
        </div>
    </body>
    </html>
    """
    success = await send_email(admin_email, subject, html_content)
    await sio.emit('email-sent', {'type': 'pre-reminder', 'email': admin_email, 'success': success}, room=room_id)

async def send_voting_pre_reminder_delayed(room_id, admin_email, session_name, voting_start_at, frontend_url, admin_token, voting_start_display=None):
    try:
        start_dt = parse_iso(voting_start_at)
        if not start_dt:
            return
        
        delay = (start_dt - datetime.now(timezone.utc)).total_seconds()
        pre_delay = delay - 15 * 60
        if pre_delay > 0:
            print(f"Delaying 15-minute pre-voting reminder for room {room_id} by {pre_delay:.1f} seconds...")
            await asyncio.sleep(pre_delay)
            
            if room_id in rooms and not rooms[room_id].get('sessionClosed'):
                await send_voting_pre_reminder(room_id, admin_email, session_name, voting_start_at, frontend_url, admin_token, voting_start_display)
    except asyncio.CancelledError:
        print(f"Scheduled 15-minute pre-voting reminder for room {room_id} was cancelled.")
        pass

async def cleanup_expired_room_delayed(room_id: str, expires_at_iso: str):
    try:
        expires_dt = parse_iso(expires_at_iso)
        if not expires_dt:
            return
        delay = (expires_dt - datetime.now(timezone.utc)).total_seconds()
        if delay > 0:
            await asyncio.sleep(delay)
        
        if room_id in rooms:
            print(f"Scheduled expiration reached for room {room_id}. Deleting room.")
            del rooms[room_id]
            if room_id in room_timeouts:
                cancel_timeout(room_id, 'votingReminderTimeout')
                cancel_timeout(room_id, 'votingPreReminderTimeout')
                cancel_timeout(room_id, 'cleanupTimeout')
                del room_timeouts[room_id]
    except asyncio.CancelledError:
        pass


def get_session_status(room):
    """Returns one of 'none' | 'upcoming' | 'open' | 'expired' | 'closed'.

    'none' means the room was created without a schedule (legacy behaviour) and
    voting is always allowed. 'closed' means an admin/co-admin has ended the
    session; voting is permanently disabled but the final report stays available."""
    if room.get('sessionClosed'):
        return 'closed'
    start = parse_iso(room.get('votingStartAt'))
    if not start:
        return 'none'
    now = datetime.now(timezone.utc)
    expires = parse_iso(room.get('expiresAt'))
    if expires and now > expires:
        return 'expired'
    if now < start:
        return 'upcoming'
    return 'open'


# Helper to cancel active asyncio tasks (timeouts)
def cancel_timeout(room_id: str, timeout_name: str):
    if room_id in room_timeouts and timeout_name in room_timeouts[room_id]:
        task = room_timeouts[room_id][timeout_name]
        if task:
            task.cancel()
            room_timeouts[room_id][timeout_name] = None

async def cleanup_room_delayed(room_id: str):
    try:
        await asyncio.sleep(15)  # 15 seconds grace period
        if room_id in rooms and len(rooms[room_id]['participants']) == 0:
            room = rooms[room_id]
            # Retain closed sessions so anyone re-opening the join link can still
            # view the "Voting is now closed" message and download the report.
            if room.get('sessionClosed'):
                print(f"Room {room_id} is closed; retaining for report access.")
                return

            # Retain upcoming scheduled sessions or active scheduled sessions (until they expire)
            status = get_session_status(room)
            if status in ('upcoming', 'open') and room.get('votingStartAt'):
                print(f"Room {room_id} is a scheduled session (status: {status}); keeping alive.")
                return

            del rooms[room_id]
            if room_id in room_timeouts:
                cancel_timeout(room_id, 'votingReminderTimeout')
                cancel_timeout(room_id, 'votingPreReminderTimeout')
                del room_timeouts[room_id]
            print(f"Room {room_id} deleted due to inactivity.")
    except asyncio.CancelledError:
        pass


@sio.event
async def connect(sid, environ):
    # Retrieve connection session data (empty at start)
    await sio.save_session(sid, {'roomId': None, 'userId': None})
    print(f"Socket connected: {sid}")

@sio.on('join-room')
async def join_room(sid, data):
    print(f"DEBUG join-room payload: {data}")
    room_id = data.get('roomId')
    user = data.get('user')
    session_name = data.get('sessionName')
    session_priority = data.get('sessionPriority', 'Medium')
    deck_type = data.get('deckType', 'Fibonacci')
    voting_start_at = data.get('votingStartAt')
    voting_end_at = data.get('votingEndAt')
    admin_email = data.get('adminEmail')
    frontend_url = data.get('frontendUrl', 'http://localhost:3000')
    client_admin_token = data.get('adminToken')
    voting_start_display = data.get('votingStartDisplay')
    voting_end_display = data.get('votingEndDisplay')

    if not room_id or not user:
        return

    user_id = user.get('id')

    # Cancel user disconnect timeout if exists
    user_key = (room_id, user_id)
    if user_key in user_disconnect_timeouts:
        task = user_disconnect_timeouts[user_key]
        if task:
            task.cancel()
        del user_disconnect_timeouts[user_key]
        print(f"Cancelled disconnect timeout for user {user.get('name')} rejoining room {room_id}.")

    # Initialize room state if it doesn't exist
    if room_id not in rooms:
        # Validate scheduled voting window (only when a start time is provided).
        # The voting start must be in the future; otherwise reject creation.
        parsed_start = parse_iso(voting_start_at)
        if parsed_start is not None and parsed_start <= datetime.now(timezone.utc):
            await sio.emit(
                'session-error',
                {'message': 'Voting start time must be in the future.'},
                to=sid
            )
            return

        expires_at = compute_expires_at(voting_start_at, voting_end_at)

        initial_task = None
        if session_name:
            initial_task = {
                'id': 'INFO',
                'title': session_name,
                'desc': 'Sprint Session Initialized'
            }
        
        room_admin_token = secrets.token_hex(8)
        rooms[room_id] = {
            'roomId': room_id,
            'participants': [],
            'taskInfo': initial_task,
            'backlog': [{
                'id': 'INFO',
                'title': initial_task['title'],
                'desc': initial_task['desc'],
                'priority': session_priority,
                'estimate': None,
                'status': 'active',
                'votesHistory': None,
                'average': None,
                'agreement': None
            }] if initial_task else [],
            'showVotes': False,
            'deckType': deck_type,
            'hostUserId': user_id,
            'createdAt': datetime.now(timezone.utc).isoformat(),
            'votingStartAt': voting_start_at or None,
            'votingEndAt': voting_end_at or None,
            'votingStartDisplay': voting_start_display or None,
            'votingEndDisplay': voting_end_display or None,
            'expiresAt': expires_at,
            'sessionClosed': False,
            'closedAt': None,
            'sessionPriority': session_priority,
            'adminEmail': admin_email or None,
            'frontendUrl': frontend_url,
            'adminToken': room_admin_token
        }
        room_timeouts[room_id] = {'cleanupTimeout': None, 'hostTransferTimeout': None, 'votingReminderTimeout': None, 'votingPreReminderTimeout': None}

        # Send scheduling confirmation and set up reminder
        if voting_start_at and admin_email:
            try:
                await send_scheduling_confirmation(
                    room_id=room_id,
                    admin_email=admin_email,
                    session_name=session_name or "Sprint Session",
                    voting_start_at=voting_start_at,
                    voting_end_at=voting_end_at,
                    expires_at=expires_at,
                    frontend_url=frontend_url,
                    admin_token=room_admin_token,
                    voting_start_display=voting_start_display,
                    voting_end_display=voting_end_display
                )
            except Exception as e:
                print(f"Error sending scheduling confirmation: {e}")
            room_timeouts[room_id]['votingReminderTimeout'] = asyncio.create_task(
                send_voting_reminder_delayed(
                    room_id=room_id,
                    admin_email=admin_email,
                    session_name=session_name or "Sprint Session",
                    voting_start_at=voting_start_at,
                    frontend_url=frontend_url,
                    admin_token=room_admin_token,
                    voting_start_display=voting_start_display
                )
            )
            room_timeouts[room_id]['votingPreReminderTimeout'] = asyncio.create_task(
                send_voting_pre_reminder_delayed(
                    room_id=room_id,
                    admin_email=admin_email,
                    session_name=session_name or "Sprint Session",
                    voting_start_at=voting_start_at,
                    frontend_url=frontend_url,
                    admin_token=room_admin_token,
                    voting_start_display=voting_start_display
                )
            )
            if expires_at:
                asyncio.create_task(
                    cleanup_expired_room_delayed(
                        room_id=room_id,
                        expires_at_iso=expires_at
                    )
                )
    else:
        # Rejoining active room: cancel cleanup and host transfer tasks
        if room_id not in room_timeouts:
            room_timeouts[room_id] = {'cleanupTimeout': None, 'hostTransferTimeout': None, 'votingReminderTimeout': None, 'votingPreReminderTimeout': None}
        
        cancel_timeout(room_id, 'cleanupTimeout')
        if rooms[room_id]['hostUserId'] == user_id:
            cancel_timeout(room_id, 'hostTransferTimeout')

    room = rooms[room_id]

    # Elevate client to Host if they join using the adminToken link
    if client_admin_token and client_admin_token == room.get('adminToken'):
        room['hostUserId'] = user_id
        print(f"User {user.get('name')} elevated to Session Host via matching adminToken.")

    # Block joining a session that has already expired.
    if get_session_status(room) == 'expired':
        await sio.emit(
            'session-error',
            {'message': 'This voting session has expired.', 'expired': True},
            to=sid
        )
        return

    # Save room and user info inside connection session for quick retrieval
    await sio.save_session(sid, {'roomId': room_id, 'userId': user_id})

    # Host status check (either creator or assigned host)
    is_host = user_id == room['hostUserId']

    # Update or insert participant list
    participants = room['participants']
    existing_index = next((i for i, p in enumerate(participants) if p['id'] == user_id), -1)

    if existing_index != -1:
        existing_vote = participants[existing_index].get('vote')
        existing_cohost = participants[existing_index].get('isCoHost', False)
        participants[existing_index] = {
            **user,
            'isHost': is_host,
            'isCoHost': existing_cohost,
            'vote': existing_vote,
            'isOffline': False,
            'sid': sid
        }
    else:
        participants.append({**user, 'isHost': is_host, 'isCoHost': False, 'vote': None, 'isOffline': False, 'sid': sid})

    # Join the Socket.io room channel
    await sio.enter_room(sid, room_id)

    # Sync room state to all players & alert other members
    await sio.emit('sync-state', room, room=room_id)
    await sio.emit('user-joined', {'name': user.get('name')}, room=room_id, skip_sid=sid)
    print(f"User {user.get('name')} joined room {room_id}")

@sio.on('cast-vote')
async def cast_vote(sid, data):
    session = await sio.get_session(sid)
    room_id = session.get('roomId')
    user_id = session.get('userId')

    if not room_id or room_id not in rooms:
        return

    vote = data.get('vote')
    room = rooms[room_id]

    # Enforce the scheduled voting window before recording any vote.
    status = get_session_status(room)
    if status == 'closed':
        await sio.emit(
            'session-error',
            {'message': 'Voting is now closed for this session.', 'closed': True},
            to=sid
        )
        return
    if status == 'upcoming':
        await sio.emit('session-error', {'message': 'Voting has not started yet.'}, to=sid)
        return
    if status == 'expired':
        await sio.emit(
            'session-error',
            {'message': 'This voting session has expired.', 'expired': True},
            to=sid
        )
        return

    # Locate participant and cast vote
    participant = next((p for p in room['participants'] if p['id'] == user_id), None)
    if participant:
        participant['vote'] = vote
        await sio.emit('sync-state', room, room=room_id)
        print(f"Vote cast: {vote} by {participant.get('name')} in room {room_id}")

@sio.on('reveal-cards')
async def reveal_cards(sid):
    session = await sio.get_session(sid)
    room_id = session.get('roomId')

    if not room_id or room_id not in rooms:
        return

    room = rooms[room_id]
    room['showVotes'] = True
    payload = dict(room)
    payload['justRevealed'] = True
    await sio.emit('sync-state', payload, room=room_id)
    print(f"Cards revealed in room {room_id}")

@sio.on('reset-round')
async def reset_round(sid):
    session = await sio.get_session(sid)
    room_id = session.get('roomId')

    if not room_id or room_id not in rooms:
        return

    room = rooms[room_id]
    room['showVotes'] = False
    for p in room['participants']:
        p['vote'] = None

    await sio.emit('sync-state', room, room=room_id)
    print(f"Round reset in room {room_id}")

@sio.on('update-deck')
async def update_deck(sid, data):
    session = await sio.get_session(sid)
    room_id = session.get('roomId')

    if not room_id or room_id not in rooms:
        return

    deck_type = data.get('deckType')
    room = rooms[room_id]
    room['deckType'] = deck_type
    await sio.emit('sync-state', room, room=room_id)
    print(f"Deck type updated to {deck_type} in room {room_id}")

@sio.on('timer-control')
async def timer_control(sid, data):
    session = await sio.get_session(sid)
    room_id = session.get('roomId')

    if not room_id:
        return

    is_running = data.get('isRunning')
    seconds = data.get('seconds')

    await sio.emit('timer-update', {'isRunning': is_running, 'seconds': seconds}, room=room_id)
    print(f"Timer sync: isRunning={is_running}, seconds={seconds} in room {room_id}")

@sio.on('update-ticket')
async def update_ticket(sid, data):
    session = await sio.get_session(sid)
    room_id = session.get('roomId')

    if not room_id or room_id not in rooms:
        return

    task_info = data.get('taskInfo')
    room = rooms[room_id]
    # A closed session's board is immutable so the final report stays intact.
    if room.get('sessionClosed'):
        return
    room['taskInfo'] = task_info
    await sio.emit('sync-state', room, room=room_id)
    print(f"Active ticket updated in room {room_id}")

@sio.on('update-backlog')
async def update_backlog(sid, data):
    session = await sio.get_session(sid)
    room_id = session.get('roomId')

    if not room_id or room_id not in rooms:
        return

    backlog = data.get('backlog')
    room = rooms[room_id]
    # A closed session's backlog is frozen so the final report stays intact.
    if room.get('sessionClosed'):
        return
    room['backlog'] = backlog
    await sio.emit('sync-state', room, room=room_id)
    print(f"Backlog updated in room {room_id}")

@sio.on('make-cohost')
async def make_cohost(sid, data):
    session = await sio.get_session(sid)
    room_id = session.get('roomId')
    user_id = session.get('userId')

    if not room_id or room_id not in rooms:
        return

    room = rooms[room_id]
    target_user_id = data.get('userId')
    
    # Only host can promote to co-admin
    if user_id != room['hostUserId'] or not target_user_id or target_user_id == user_id:
        return

    target = next((p for p in room['participants'] if p['id'] == target_user_id), None)
    if not target:
        return

    # Set the target as co-host
    target['isCoHost'] = True

    await sio.emit('sync-state', room, room=room_id)
    await sio.emit(
        'cohost-updated',
        {
            'message': f"{target.get('name')} has been promoted to Co-Admin!",
            'participants': room['participants']
        },
        room=room_id
    )
    print(f"{target.get('name')} was promoted to Co-Admin in room {room_id}")


@sio.on('close-session')
async def close_session(sid, data=None):
    session = await sio.get_session(sid)
    room_id = session.get('roomId')
    user_id = session.get('userId')

    if not room_id or room_id not in rooms:
        return

    room = rooms[room_id]

    # Only the Admin (host) or a Co-Admin may close the session.
    is_host = user_id == room.get('hostUserId')
    participant = next((p for p in room['participants'] if p['id'] == user_id), None)
    is_cohost = bool(participant.get('isCoHost')) if participant else False
    if not (is_host or is_cohost):
        await sio.emit(
            'session-error',
            {'message': 'Only the Admin or Co-Admin can close the session.'},
            to=sid
        )
        return

    if room.get('sessionClosed'):
        return  # already closed; nothing to do

    # Cancel scheduled reminder task since session is now closed
    cancel_timeout(room_id, 'votingReminderTimeout')

    # Mark every story as completed while preserving existing estimates/history.
    for item in room.get('backlog', []):
        if item.get('id') == 'INFO':
            continue
        item['status'] = 'completed'

    room['sessionClosed'] = True
    room['closedAt'] = datetime.now(timezone.utc).isoformat()
    room['showVotes'] = False
    room['taskInfo'] = None

    await sio.emit('sync-state', room, room=room_id)
    await sio.emit(
        'session-closed',
        {'message': 'Voting is now closed for this session.'},
        room=room_id
    )
    print(f"Session closed in room {room_id} by {'host' if is_host else 'co-host'} {user_id}")


@sio.event
async def disconnect(sid):
    session = await sio.get_session(sid)
    room_id = session.get('roomId')
    user_id = session.get('userId')

    if not room_id or room_id not in rooms:
        print(f"Socket disconnected: {sid}")
        return

    room = rooms[room_id]
    participants = room['participants']
    index = next((i for i, p in enumerate(participants) if p['id'] == user_id), -1)

    if index != -1:
        participant = participants[index]
        # Ignore disconnect event if the user has already reconnected with a different socket (sid)
        if participant.get('sid') != sid:
            print(f"Ignored disconnect for user {participant.get('name')} - active connection has a different sid ({participant.get('sid')} vs {sid}).")
            return

        was_host = participant.get('isHost', False)
        leaving_user_name = participant.get('name')
        
        # Mark participant as offline temporarily
        participant['isOffline'] = True
        print(f"User {leaving_user_name} disconnected temporarily from room {room_id}")

        # Broadcast the offline status to others immediately
        await sio.emit('sync-state', room, room=room_id)

        # Cancel any existing disconnect timeout for this user (just in case)
        user_key = (room_id, user_id)
        if user_key in user_disconnect_timeouts:
            task = user_disconnect_timeouts[user_key]
            if task:
                task.cancel()

        # Start 5s grace period for removal
        async def remove_participant_delayed():
            try:
                await asyncio.sleep(5)
                # Double check room and user still exist
                if room_id in rooms:
                    current_participants = rooms[room_id]['participants']
                    curr_idx = next((i for i, p in enumerate(current_participants) if p['id'] == user_id), -1)
                    if curr_idx != -1 and current_participants[curr_idx].get('isOffline'):
                        # Remove participant permanently
                        current_participants.pop(curr_idx)
                        print(f"User {leaving_user_name} removed permanently from room {room_id} after 5s disconnect timeout.")
                        
                        if room_id not in room_timeouts:
                            room_timeouts[room_id] = {'cleanupTimeout': None, 'hostTransferTimeout': None}

                        # Room empty check
                        if len(current_participants) == 0:
                            cancel_timeout(room_id, 'cleanupTimeout')
                            room_timeouts[room_id]['cleanupTimeout'] = asyncio.create_task(cleanup_room_delayed(room_id))
                            print(f"Room {room_id} is empty. Scheduled cleanup in 15 seconds.")
                        else:
                            if was_host:
                                print(f"Host left room {room_id}. Host status will not be transferred.")
                            await sio.emit('sync-state', rooms[room_id], room=room_id)
                            await sio.emit('user-left', {'name': leaving_user_name}, room=room_id)
                
                # Clean up timeout reference
                if user_key in user_disconnect_timeouts:
                    del user_disconnect_timeouts[user_key]
            except asyncio.CancelledError:
                pass

        user_disconnect_timeouts[user_key] = asyncio.create_task(remove_participant_delayed())

    print(f"Socket disconnected: {sid}")

# Fallback: serve React/Angular built SPA files if dist directory exists
dist_path = os.path.join(os.path.dirname(__file__), 'dist', 'browser')
if not os.path.exists(dist_path):
    dist_path = os.path.join(os.path.dirname(__file__), 'dist')
if not os.path.exists(dist_path) or not os.path.exists(os.path.join(dist_path, 'index.html')):
    dist_path = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'dist', 'frontend', 'browser')

if os.path.exists(dist_path) and (os.path.exists(os.path.join(dist_path, 'index.html')) or os.path.isdir(dist_path)):
    print(f"Production static folder found at {dist_path}. Mounting static assets.")

    @app.get("/")
    async def get_index():
        return FileResponse(os.path.join(dist_path, "index.html"))

    @app.get("/join/{room_id}")
    async def get_join_room(room_id: str):
        return FileResponse(os.path.join(dist_path, "index.html"))

    # Mount static assets directory
    app.mount("/", StaticFiles(directory=dist_path, html=True), name="static")

    # Fallback to SPA routing for other routes
    @app.exception_handler(404)
    async def spa_fallback(request, exc):
        return FileResponse(os.path.join(dist_path, "index.html"))
else:
    print("Standalone Backend Mode: Serves API endpoints only.")
    @app.get("/")
    async def get_api_root():
        return JSONResponse({
            "status": "ok",
            "message": "EXL Sprint Grooming Python Socket.io server is running!"
        })

# Start production server when run directly
if __name__ == '__main__':
    import uvicorn
    PORT = int(os.environ.get('PORT', 3000))
    print(f"Starting server on port {PORT}...")
    uvicorn.run(socket_app, host='127.0.0.1' if os.name == 'nt' else '0.0.0.0', port=PORT)
