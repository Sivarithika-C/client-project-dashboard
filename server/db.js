const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'dashboard.db'));
db.pragma('journal_mode = WAL');

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','manager','client')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','on_hold','completed')),
  manager_id INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(project_id, user_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','review','done')),
  assignee_id INTEGER REFERENCES users(id),
  due_date TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

// ---------- Seed (only if empty) ----------
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

if (userCount === 0) {
  const insertUser = db.prepare(
    'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
  );
  const hash = (pw) => bcrypt.hashSync(pw, 10);

  const adminId = insertUser.run('Alex Admin', 'admin@demo.com', hash('admin123'), 'admin').lastInsertRowid;
  const managerId = insertUser.run('Priya Manager', 'manager@demo.com', hash('manager123'), 'manager').lastInsertRowid;
  const manager2Id = insertUser.run('Sam Manager', 'sam@demo.com', hash('manager123'), 'manager').lastInsertRowid;
  const clientId = insertUser.run('Chris Client', 'client@demo.com', hash('client123'), 'client').lastInsertRowid;
  const client2Id = insertUser.run('Dana Client', 'dana@demo.com', hash('client123'), 'client').lastInsertRowid;

  const insertProject = db.prepare(
    'INSERT INTO projects (name, description, status, manager_id) VALUES (?, ?, ?, ?)'
  );
  const p1 = insertProject.run('Website Redesign', 'Full redesign of the marketing site', 'active', managerId).lastInsertRowid;
  const p2 = insertProject.run('Mobile App Launch', 'iOS/Android app v1 launch', 'active', manager2Id).lastInsertRowid;
  const p3 = insertProject.run('Data Migration', 'Legacy DB to cloud migration', 'on_hold', managerId).lastInsertRowid;

  const insertMember = db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)');
  insertMember.run(p1, clientId);
  insertMember.run(p2, client2Id);
  insertMember.run(p3, clientId);

  const insertTask = db.prepare(
    'INSERT INTO tasks (project_id, title, description, status, assignee_id, due_date) VALUES (?, ?, ?, ?, ?, ?)'
  );
  insertTask.run(p1, 'Wireframe homepage', 'Create low-fi wireframes', 'done', managerId, '2026-09-05');
  insertTask.run(p1, 'Design system setup', 'Colors, type, components', 'in_progress', managerId, '2026-09-22');
  insertTask.run(p1, 'Client review round 1', 'Share designs for feedback', 'review', managerId, '2026-09-25');
  insertTask.run(p1, 'Build landing page', 'Implement in React', 'todo', managerId, '2026-09-30');

  insertTask.run(p2, 'App store assets', 'Screenshots & description', 'in_progress', manager2Id, '2026-09-21');
  insertTask.run(p2, 'Beta testing', 'Recruit 20 testers', 'todo', manager2Id, '2026-09-28');
  insertTask.run(p2, 'Push notification setup', 'Configure FCM/APNs', 'done', manager2Id, '2026-09-10');

  insertTask.run(p3, 'Schema audit', 'Review legacy schema', 'todo', managerId, '2026-10-05');

  const insertActivity = db.prepare(
    'INSERT INTO activities (project_id, user_id, type, message, meta) VALUES (?, ?, ?, ?, ?)'
  );
  insertActivity.run(p1, managerId, 'task_created', 'Priya created task "Wireframe homepage"', null);
  insertActivity.run(p1, managerId, 'task_status', 'Priya moved "Wireframe homepage" to Done', null);
  insertActivity.run(p2, manager2Id, 'task_status', 'Sam moved "Push notification setup" to Done', null);
  insertActivity.run(p1, clientId, 'comment', 'Chris commented: "Looking great so far!"', null);

  console.log('Seed data created:');
  console.log('  admin@demo.com / admin123');
  console.log('  manager@demo.com / manager123 (Priya)');
  console.log('  sam@demo.com / manager123 (Sam)');
  console.log('  client@demo.com / client123 (Chris - Website Redesign, Data Migration)');
  console.log('  dana@demo.com / client123 (Dana - Mobile App Launch)');
}

module.exports = db;
