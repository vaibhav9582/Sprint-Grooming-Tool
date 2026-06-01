# EXL Sprint Grooming Planning Poker Tool

A modern, real-time Planning Poker and sprint grooming application designed for agile development teams. This platform enables seamless estimation sessions with real-time sync, Jira integration, and automated reporting.

---

## 🚀 Features

- **Real-Time Multiplayer Poker**: Bidirectional sync utilizing WebSockets/Socket.io to track voter connections, card selections, card reveals, and round resets instantly.
- **Scrum Master Controls**: 
  - Host authorization checks.
  - Active ticket configuration.
  - Reveal cards, reset rounds, and custom discussion timer controls.
  - **Lock Score**: Save estimates to the backlog and auto-load the next pending ticket.
- **Active Backlog Queue**: Manage, reorder, add, or delete sprint tickets. Completed tickets display finalized average scores and consensus agreement levels.
- **Detailed Estimation Reporting**: 
  - Scrum Master can export single-ticket logs or the consolidated session backlog.
  - Formats: **JSON** and normalized **CSV** (for easy import into Excel or Jira).
- **Jira Integration**: Authenticate with your Jira instance and sync sprint issues directly into the backlog queue (with a mock Demo Mode for offline evaluation).
- **Flexible Deck Systems**: Support for Fibonacci (`0-55`, `?`, `☕`), T-Shirt Size (`XS-XXL`, `?`, `☕`), and Sequential (`1-10`, `?`, `☕`).
- **Dynamic Seating & Aesthetics**: Vibrant layout mapping estimators around a central board. Responsive layout adjusts seamlessly from mobile cards to desktop seat arrays.
- **Dual-Theme Support**: Instant toggle between premium Light Mode and dark-slate Dark Mode.

---

## 🛠️ Tech Stack

### Frontend
- **Framework**: Angular v21 (Single Page Application)
- **Styling**: Tailwind CSS v4
- **Communication**: Socket.io-client (Real-time events)

### Backend
- **Framework**: FastAPI (Python 3)
- **ASGI Server**: Uvicorn
- **Sockets**: `python-socketio` (Asynchronous event server)

---

## 🏁 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Python 3.8+](https://www.python.org/)

### Installation
From the root directory, run the unified installation script. This will install the frontend dependencies, create a Python virtual environment (`venv`), and install backend requirements:
```bash
npm run install:all
```

### Running the Project

You can run the frontend and backend development servers concurrently:

1. **Start the Backend Server** (runs on port `3000`):
   ```bash
   npm run dev:backend
   ```

2. **Start the Frontend Dev Server** (runs on port `4200`):
   ```bash
   npm run dev:frontend
   ```

Open your browser and navigate to: **[http://localhost:4200](http://localhost:4200)**

---

## 📂 Project Structure

```text
├── backend/
│   ├── requirements.txt   # Python dependencies (fastapi, python-socketio, etc.)
│   └── server.py          # FastAPI application & Socket.io server logic
├── frontend/
│   ├── angular.json       # Angular workspace configuration
│   ├── package.json       # Frontend scripts and dependencies
│   └── src/
│       ├── app/
│       │   ├── app.ts     # Main Angular Component (estimation logic & exports)
│       │   ├── app.html   # Main layout template
│       │   └── app.css    # Scoped styles
│       └── styles.css     # Tailwind imports and custom design tokens
├── package.json           # Root scripts for installation and execution
└── README.md              # Project documentation
```

---

## 📦 Production Deployment

The project can be bundled and run from a single port:

1. **Build the production bundle**:
   ```bash
   npm run build:prod
   ```
   This compiles the Angular client and outputs static files to `frontend/dist/frontend/browser`.

2. **Start the unified server**:
   ```bash
   npm run start
   ```
   The FastAPI server in `server.py` will detect the production build folders, automatically host the built static assets on the root path, and fallback to SPA routing for deep-links.
