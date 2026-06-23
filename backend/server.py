import os
import asyncio
import urllib.request
import json
import base64
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
                "desc": "Implement OAuth2 authentication flow and connect to the user database."
            },
            {
                "id": "JIRA-102",
                "title": "Database Optimization",
                "desc": "Optimize PostgreSQL indexes for high-frequency queries on the transaction log table."
            },
            {
                "id": "JIRA-103",
                "title": "Docker Setup",
                "desc": "Containerize the FastAPI backend and Angular frontend for production deployment."
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
                
            issues.append({
                "id": issue_id,
                "title": title,
                "desc": desc
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

# Helper to cancel active asyncio tasks (timeouts)
def cancel_timeout(room_id: str, timeout_name: str):
    if room_id in room_timeouts and timeout_name in room_timeouts[room_id]:
        task = room_timeouts[room_id][timeout_name]
        if task:
            task.cancel()
            room_timeouts[room_id][timeout_name] = None

# Delayed async task to clean up a room when empty
async def cleanup_room_delayed(room_id: str):
    try:
        await asyncio.sleep(15)  # 15 seconds grace period
        if room_id in rooms and len(rooms[room_id]['participants']) == 0:
            del rooms[room_id]
            if room_id in room_timeouts:
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
    room_id = data.get('roomId')
    user = data.get('user')
    session_name = data.get('sessionName')
    deck_type = data.get('deckType', 'Fibonacci')

    if not room_id or not user:
        return

    user_id = user.get('id')

    # Initialize room state if it doesn't exist
    if room_id not in rooms:
        initial_task = None
        if session_name:
            initial_task = {
                'id': 'INFO',
                'title': session_name,
                'desc': 'Sprint Session Initialized'
            }
        
        rooms[room_id] = {
            'roomId': room_id,
            'participants': [],
            'taskInfo': initial_task,
            'backlog': [{
                'id': 'INFO',
                'title': initial_task['title'],
                'desc': initial_task['desc'],
                'estimate': None,
                'status': 'active',
                'votesHistory': None,
                'average': None,
                'agreement': None
            }] if initial_task else [],
            'showVotes': False,
            'deckType': deck_type,
            'hostUserId': user_id
        }
        room_timeouts[room_id] = {'cleanupTimeout': None, 'hostTransferTimeout': None}
    else:
        # Rejoining active room: cancel cleanup and host transfer tasks
        if room_id not in room_timeouts:
            room_timeouts[room_id] = {'cleanupTimeout': None, 'hostTransferTimeout': None}
        
        cancel_timeout(room_id, 'cleanupTimeout')
        if rooms[room_id]['hostUserId'] == user_id:
            cancel_timeout(room_id, 'hostTransferTimeout')

    room = rooms[room_id]

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
        participants[existing_index] = {**user, 'isHost': is_host, 'isCoHost': existing_cohost, 'vote': existing_vote}
    else:
        participants.append({**user, 'isHost': is_host, 'isCoHost': False, 'vote': None})

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
        was_host = participants[index].get('isHost', False)
        leaving_user_name = participants[index].get('name')
        
        # Remove participant
        participants.pop(index)
        print(f"User {leaving_user_name} disconnected from room {room_id}")

        if room_id not in room_timeouts:
            room_timeouts[room_id] = {'cleanupTimeout': None, 'hostTransferTimeout': None}

        # Room empty check
        if len(participants) == 0:
            # Cancel any existing cleanup timers
            cancel_timeout(room_id, 'cleanupTimeout')
            # Start 15s grace cleanup timer
            room_timeouts[room_id]['cleanupTimeout'] = asyncio.create_task(cleanup_room_delayed(room_id))
            print(f"Room {room_id} is empty. Scheduled cleanup in 15 seconds.")
        else:
            # If host left, do not transfer host status
            if was_host:
                print(f"Host left room {room_id}. Host status will not be transferred.")
            
            # Sync new state and announce departure to active members
            await sio.emit('sync-state', room, room=room_id)
            await sio.emit('user-left', {'name': leaving_user_name}, room=room_id)

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
