require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
}

// Returns the set of project IDs a given user is allowed to see.
function visibleProjectIds(user) {
  if (user.role === 'admin') {
    return db.prepare('SELECT id FROM projects').all().map((r) => r.id);
  }
  if (user.role === 'manager') {
    return db
      .prepare('SELECT id FROM projects WHERE manager_id = ?')
      .all(user.id)
      .map((r) => r.id);
  }
  // client
  return db
    .prepare('SELECT project_id AS id FROM project_members WHERE user_id = ?')
    .all(user.id)
    .map((r) => r.id);
}

function canAccessProject(user, projectId) {
  return visibleProjectIds(user).includes(Number(projectId));
}

function logActivity({ projectId, userId, type, message, meta }) {
  const info = db
    .prepare(
      'INSERT INTO activities (project_id, user_id, type, message, meta) VALUES (?, ?, ?, ?, ?)'
    )
    .run(projectId, userId, type, message, meta ? JSON.stringify(meta) : null);

  const activity = db
    .prepare(
      `SELECT a.*, u.name AS user_name, u.role AS user_role
       FROM activities a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.id = ?`
    )
    .get(info.lastInsertRowid);

  // Broadcast to everyone allowed to see this project (room = project_<id>),
  // plus a global 'admins' room so admins see every activity live.
  io.to(`project_${projectId}`).to('admins').emit('activity', activity);
  return activity;
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ---------------------------------------------------------------------------
// Users (admin only)
// ---------------------------------------------------------------------------
app.get('/api/users', authMiddleware, requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, created_at FROM users').all();
  res.json({ users });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
app.get('/api/projects', authMiddleware, (req, res) => {
  const ids = visibleProjectIds(req.user);
  if (ids.length === 0) return res.json({ projects: [] });

  const placeholders = ids.map(() => '?').join(',');
  const projects = db
    .prepare(
      `SELECT p.*, u.name AS manager_name,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count
       FROM projects p LEFT JOIN users u ON u.id = p.manager_id
       WHERE p.id IN (${placeholders})
       ORDER BY p.created_at DESC`
    )
    .all(...ids);

  res.json({ projects });
});

app.post('/api/projects', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Project name required' });

  const managerId = req.user.role === 'manager' ? req.user.id : req.body.manager_id || req.user.id;
  const info = db
    .prepare('INSERT INTO projects (name, description, manager_id) VALUES (?, ?, ?)')
    .run(name, description || '', managerId);

  logActivity({
    projectId: info.lastInsertRowid,
    userId: req.user.id,
    type: 'project_created',
    message: `${req.user.name} created project "${name}"`,
  });

  res.status(201).json({ id: info.lastInsertRowid });
});

app.post(
  '/api/projects/:id/members',
  authMiddleware,
  requireRole('admin', 'manager'),
  (req, res) => {
    const projectId = req.params.id;
    const { user_id } = req.body || {};
    if (!canAccessProject(req.user, projectId)) return res.status(403).json({ error: 'Forbidden' });

    db.prepare(
      'INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)'
    ).run(projectId, user_id);

    res.status(201).json({ ok: true });
  }
);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
app.get('/api/projects/:id/tasks', authMiddleware, (req, res) => {
  const projectId = req.params.id;
  if (!canAccessProject(req.user, projectId)) return res.status(403).json({ error: 'Forbidden' });

  const tasks = db
    .prepare(
      `SELECT t.*, u.name AS assignee_name FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id = ? ORDER BY t.created_at ASC`
    )
    .all(projectId);

  res.json({ tasks });
});

app.post(
  '/api/projects/:id/tasks',
  authMiddleware,
  requireRole('admin', 'manager'),
  (req, res) => {
    const projectId = req.params.id;
    const { title, description, assignee_id, due_date } = req.body || {};
    if (!canAccessProject(req.user, projectId)) return res.status(403).json({ error: 'Forbidden' });
    if (!title) return res.status(400).json({ error: 'Task title required' });

    const info = db
      .prepare(
        'INSERT INTO tasks (project_id, title, description, assignee_id, due_date) VALUES (?, ?, ?, ?, ?)'
      )
      .run(projectId, title, description || '', assignee_id || null, due_date || null);

    logActivity({
      projectId,
      userId: req.user.id,
      type: 'task_created',
      message: `${req.user.name} created task "${title}"`,
    });

    res.status(201).json({ id: info.lastInsertRowid });
  }
);

app.patch('/api/tasks/:id', authMiddleware, requireRole('admin', 'manager'), (req, res) => {
  const taskId = req.params.id;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!canAccessProject(req.user, task.project_id)) return res.status(403).json({ error: 'Forbidden' });

  const { status, title, description, assignee_id, due_date } = req.body || {};
  const next = {
    status: status ?? task.status,
    title: title ?? task.title,
    description: description ?? task.description,
    assignee_id: assignee_id ?? task.assignee_id,
    due_date: due_date ?? task.due_date,
  };

  db.prepare(
    `UPDATE tasks SET status=?, title=?, description=?, assignee_id=?, due_date=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(next.status, next.title, next.description, next.assignee_id, next.due_date, taskId);

  if (status && status !== task.status) {
    const statusLabels = { todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' };
    logActivity({
      projectId: task.project_id,
      userId: req.user.id,
      type: 'task_status',
      message: `${req.user.name} moved "${task.title}" to ${statusLabels[status] || status}`,
    });
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Comments / Activity feed
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/comments', authMiddleware, (req, res) => {
  const projectId = req.params.id;
  const { message } = req.body || {};
  if (!canAccessProject(req.user, projectId)) return res.status(403).json({ error: 'Forbidden' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });

  const activity = logActivity({
    projectId,
    userId: req.user.id,
    type: 'comment',
    message: `${req.user.name} commented: "${message.trim()}"`,
    meta: { raw: message.trim() },
  });

  res.status(201).json({ activity });
});

app.get('/api/activities', authMiddleware, (req, res) => {
  const ids = visibleProjectIds(req.user);
  if (ids.length === 0) return res.json({ activities: [] });

  const placeholders = ids.map(() => '?').join(',');
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const activities = db
    .prepare(
      `SELECT a.*, u.name AS user_name, u.role AS user_role, p.name AS project_name
       FROM activities a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE a.project_id IN (${placeholders})
       ORDER BY a.created_at DESC LIMIT ?`
    )
    .all(...ids, limit);

  res.json({ activities });
});

// ---------------------------------------------------------------------------
// Socket.IO — auth on connection, join rooms by visible projects
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Missing auth token'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const user = socket.user;
  const ids = visibleProjectIds(user);
  ids.forEach((id) => socket.join(`project_${id}`));
  if (user.role === 'admin') socket.join('admins');

  socket.emit('connected', { message: `Live feed connected as ${user.name} (${user.role})` });

  socket.on('disconnect', () => {});
});

server.listen(PORT, () => {
  console.log(`Client Project Dashboard running on http://localhost:${PORT}`);
});
