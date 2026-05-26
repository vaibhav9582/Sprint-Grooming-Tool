import os
import asyncio
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

# Delayed async task to transfer host when original host disconnects
async def host_transfer_delayed(room_id: str):
    try:
        await asyncio.sleep(5)  # 5 seconds grace period
        if room_id in rooms:
            room = rooms[room_id]
            has_host = any(p.get('isHost') for p in room['participants'])
            if len(room['participants']) > 0 and not has_host:
                # Assign host status to first participant
                room['participants'][0]['isHost'] = True
                room['hostUserId'] = room['participants'][0]['id']
                await sio.emit('sync-state', room, room=room_id)
                print(f"Room {room_id} host transferred to {room['participants'][0]['name']}.")
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
        participants[existing_index] = {**user, 'isHost': is_host, 'vote': existing_vote}
    else:
        participants.append({**user, 'isHost': is_host, 'vote': None})

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
    await sio.emit('sync-state', room, room=room_id)
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
            # If host left, wait 5 seconds to transfer host status
            if was_host:
                cancel_timeout(room_id, 'hostTransferTimeout')
                room_timeouts[room_id]['hostTransferTimeout'] = asyncio.create_task(host_transfer_delayed(room_id))
                print(f"Host left room {room_id}. Scheduled host transfer in 5 seconds.")
            
            # Sync new state and announce departure to active members
            await sio.emit('sync-state', room, room=room_id)
            await sio.emit('user-left', {'name': leaving_user_name}, room=room_id)

    print(f"Socket disconnected: {sid}")

# Fallback: serve React/Angular built SPA files if dist directory exists
dist_path = os.path.join(os.path.dirname(__file__), 'dist', 'browser')
if not os.path.exists(dist_path):
    dist_path = os.path.join(os.path.dirname(__file__), 'dist')

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
