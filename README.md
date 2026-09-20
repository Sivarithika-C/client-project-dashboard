# ClientPulse — Real-Time Client Project Dashboard

A full-stack project dashboard with **role-based access control** and a **live activity feed**, built with Node/Express, Socket.IO, and SQLite on the backend and vanilla JS on the frontend.

## Features

- **Authentication** — JWT-based login, passwords hashed with bcrypt.
- **Role-based access control (RBAC)**
  - **Admin** — sees every project, every task, every activity across the org.
  - **Manager** — sees and manages only the projects they own (create projects/tasks, move tasks across the board).
  - **Client** — read-only access to the specific project(s) they've been added to as a member, plus the ability to post comments/updates.
- **Project dashboard** — cards showing status, task completion %, and manager.
- **Task board (Kanban)** — To Do → In Progress → Review → Done, with drag-free dropdown status changes (permission-gated).
- **Live activity feed** — powered by Socket.IO. Any task creation, status change, project creation, or comment is broadcast in real time to every connected user who has permission to see that project (room-based broadcast: `project_<id>` + a global `admins` room).
- **Toasts + live badge** — visual confirmation when a new event streams in, without a page refresh.

## Tech stack

| Layer      | Choice                              |
|------------|--------------------------------------|
| Backend    | Node.js, Express                    |
| Real-time  | Socket.IO (WebSocket w/ polling fallback) |
| Database   | SQLite (`better-sqlite3`)           |
| Auth       | JWT (`jsonwebtoken`) + `bcryptjs`   |
| Frontend   | Vanilla JS, HTML, CSS (no build step) |

## Project structure

```
.
├── server/
│   ├── index.js      # Express app, REST API, Socket.IO, RBAC middleware
│   └── db.js         # SQLite schema + seed data
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js         # Frontend app: auth, rendering, socket client
├── package.json
└── README.md
```

## Data model

- `users(id, name, email, password_hash, role)`
- `projects(id, name, description, status, manager_id)`
- `project_members(project_id, user_id)` — grants a client visibility into a project
- `tasks(id, project_id, title, description, status, assignee_id, due_date)`
- `activities(id, project_id, user_id, type, message, meta, created_at)` — the event log that powers the live feed

## Running locally

```bash
npm install
npm start
```

The server starts on `http://localhost:3000` and seeds the database automatically on first run.

### Demo accounts

| Role    | Email              | Password    | Visibility                          |
|---------|--------------------|-------------|--------------------------------------|
| Admin   | admin@demo.com     | admin123    | All projects                        |
| Manager | manager@demo.com   | manager123  | Website Redesign, Data Migration    |
| Manager | sam@demo.com       | manager123  | Mobile App Launch                   |
| Client  | client@demo.com    | client123   | Website Redesign, Data Migration    |
| Client  | dana@demo.com      | client123   | Mobile App Launch                   |

**To see the live feed in action:** open the app in two browser windows, log in as `admin@demo.com` in one and `client@demo.com` in the other. Move a task or post a comment in one window and watch it appear instantly in the other, filtered correctly by role/visibility.

## Deploying for the "live link" submission

This is a standard Node app with no external services required (SQLite is file-based), so it deploys easily to any Node host:

**Render.com (recommended, free tier)**
1. Push this repo to GitHub.
2. Create a new **Web Service** on Render, connect the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Add an environment variable `JWT_SECRET` with a random string.
5. Deploy — Render gives you a public URL.

**Railway / Fly.io / Cyclic** work the same way — install + `npm start`, no Dockerfile required.

> Note: SQLite's file storage resets on most free-tier redeploys/restarts since the filesystem isn't persistent. For a production deployment you'd swap `better-sqlite3` for a hosted Postgres (e.g. via `pg`) — the query layer in `server/db.js` is intentionally isolated to make that swap straightforward.

## Design notes / trade-offs

- **Why Socket.IO rooms instead of a single global broadcast?** So the "live" feed genuinely respects role-based visibility — a client only ever receives events for projects they belong to, not a firehose of every event in the system.
- **Why SQLite?** Zero setup for grading/demo purposes. The schema and query layer are simple enough to port to Postgres/MySQL by swapping `db.js`.
- **Why no frontend framework?** Keeps the submission dependency-light and easy to review; the same component boundaries (LoginScreen, ProjectList, Board, ActivityFeed) would map cleanly onto React if the assignment called for it.
