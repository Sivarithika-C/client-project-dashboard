// ============================================================================
// State
// ============================================================================
const state = {
  token: localStorage.getItem('cp_token') || null,
  user: JSON.parse(localStorage.getItem('cp_user') || 'null'),
  projects: [],
  currentProject: null,
  tasks: [],
  socket: null,
};

const STATUS_LABELS = { todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' };

// ============================================================================
// API helper
// ============================================================================
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ============================================================================
// Elements
// ============================================================================
const el = (id) => document.getElementById(id);
const loginScreen = el('login-screen');
const appScreen = el('app-screen');

// ============================================================================
// Auth
// ============================================================================
el('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = el('login-email').value.trim();
  const password = el('login-password').value;
  el('login-error').textContent = '';
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('cp_token', data.token);
    localStorage.setItem('cp_user', JSON.stringify(data.user));
    boot();
  } catch (err) {
    el('login-error').textContent = err.message;
  }
});

document.querySelectorAll('.demo-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    el('login-email').value = btn.dataset.email;
    el('login-password').value = btn.dataset.pass;
    el('login-form').requestSubmit();
  });
});

el('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('cp_token');
  localStorage.removeItem('cp_user');
  if (state.socket) state.socket.disconnect();
  state.token = null;
  state.user = null;
  location.reload();
});

// ============================================================================
// Boot
// ============================================================================
async function boot() {
  if (!state.token || !state.user) {
    loginScreen.classList.remove('hidden');
    appScreen.classList.add('hidden');
    return;
  }
  loginScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');

  el('user-name').textContent = state.user.name;
  el('user-role').textContent = state.user.role;

  const canCreate = state.user.role === 'admin' || state.user.role === 'manager';
  el('new-project-btn').classList.toggle('hidden', !canCreate);

  connectSocket();
  await loadProjects();
  await loadActivityFeed();
}

// ============================================================================
// Socket.IO — live activity feed
// ============================================================================
function connectSocket() {
  state.socket = io({ auth: { token: state.token } });

  state.socket.on('connect', () => {
    el('live-dot').classList.add('on');
    el('live-status').textContent = 'Live';
  });

  state.socket.on('disconnect', () => {
    el('live-dot').classList.remove('on');
    el('live-status').textContent = 'Reconnecting…';
  });

  state.socket.on('activity', (activity) => {
    prependActivity(activity, true);
    // Refresh board if we're viewing the affected project
    if (state.currentProject && activity.project_id === state.currentProject.id) {
      loadTasks(state.currentProject.id);
    }
    if (!el('project-detail-view').classList.contains('hidden') === false) {
      // no-op placeholder
    }
    showToast(activity.message);
  });
}

// ============================================================================
// Projects
// ============================================================================
async function loadProjects() {
  const { projects } = await api('/api/projects');
  state.projects = projects;
  renderProjects();
}

function renderProjects() {
  const grid = el('projects-grid');
  grid.innerHTML = '';
  if (state.projects.length === 0) {
    grid.innerHTML = '<p class="muted">No projects visible for your role yet.</p>';
    return;
  }
  state.projects.forEach((p) => {
    const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
      <span class="status-pill ${p.status}">${p.status.replace('_', ' ')}</span>
      <h3>${escapeHtml(p.name)}</h3>
      <p>${escapeHtml(p.description || 'No description provided.')}</p>
      <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      <div class="progress-label">${p.done_count}/${p.task_count} tasks done (${pct}%)</div>
      <div class="manager-label">Manager: ${escapeHtml(p.manager_name || '—')}</div>
    `;
    card.addEventListener('click', () => openProject(p));
    grid.appendChild(card);
  });
}

el('new-project-btn').addEventListener('click', () => {
  openModal({
    title: 'New Project',
    fields: [
      { id: 'p-name', label: 'Project name', type: 'text' },
      { id: 'p-desc', label: 'Description', type: 'textarea' },
    ],
    onConfirm: async (values) => {
      await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: values['p-name'], description: values['p-desc'] }),
      });
      await loadProjects();
    },
  });
});

async function openProject(project) {
  state.currentProject = project;
  el('project-list-view').classList.add('hidden');
  el('project-detail-view').classList.remove('hidden');
  el('detail-project-name').textContent = project.name;
  el('detail-project-desc').textContent = project.description || '';

  const canCreate = state.user.role === 'admin' || state.user.role === 'manager';
  el('new-task-btn').classList.toggle('hidden', !canCreate);

  await loadTasks(project.id);
}

el('back-btn').addEventListener('click', () => {
  state.currentProject = null;
  el('project-detail-view').classList.add('hidden');
  el('project-list-view').classList.remove('hidden');
  loadProjects();
});

// ============================================================================
// Tasks
// ============================================================================
async function loadTasks(projectId) {
  const { tasks } = await api(`/api/projects/${projectId}/tasks`);
  state.tasks = tasks;
  renderBoard();
}

function renderBoard() {
  ['todo', 'in_progress', 'review', 'done'].forEach((status) => {
    const col = el(`col-${status}`);
    col.innerHTML = '';
    state.tasks
      .filter((t) => t.status === status)
      .forEach((t) => col.appendChild(renderTaskCard(t)));
  });
}

function renderTaskCard(task) {
  const canManage = state.user.role === 'admin' || state.user.role === 'manager';
  const card = document.createElement('div');
  card.className = 'task-card';
  card.innerHTML = `
    <div class="task-title">${escapeHtml(task.title)}</div>
    <div class="task-meta">
      <span>${escapeHtml(task.assignee_name || 'Unassigned')}</span>
      <span>${task.due_date || ''}</span>
    </div>
    ${canManage ? `<select data-task-id="${task.id}">
      ${Object.entries(STATUS_LABELS)
        .map(([val, label]) => `<option value="${val}" ${val === task.status ? 'selected' : ''}>${label}</option>`)
        .join('')}
    </select>` : ''}
  `;
  if (canManage) {
    card.querySelector('select').addEventListener('change', async (e) => {
      await api(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: e.target.value }),
      });
      await loadTasks(state.currentProject.id);
    });
  }
  return card;
}

el('new-task-btn').addEventListener('click', () => {
  openModal({
    title: 'New Task',
    fields: [
      { id: 't-title', label: 'Task title', type: 'text' },
      { id: 't-desc', label: 'Description', type: 'textarea' },
      { id: 't-due', label: 'Due date', type: 'date' },
    ],
    onConfirm: async (values) => {
      await api(`/api/projects/${state.currentProject.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title: values['t-title'], description: values['t-desc'], due_date: values['t-due'] }),
      });
      await loadTasks(state.currentProject.id);
    },
  });
});

// ============================================================================
// Comments
// ============================================================================
el('comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = el('comment-input');
  const message = input.value.trim();
  if (!message) return;
  await api(`/api/projects/${state.currentProject.id}/comments`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
  input.value = '';
});

// ============================================================================
// Activity feed
// ============================================================================
async function loadActivityFeed() {
  const { activities } = await api('/api/activities?limit=30');
  const feed = el('activity-feed');
  feed.innerHTML = '';
  activities.forEach((a) => prependActivity(a, false));
}

function prependActivity(activity, animate) {
  const feed = el('activity-feed');
  const item = document.createElement('div');
  item.className = 'activity-item';
  const time = new Date(activity.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  item.innerHTML = `
    <div class="msg"><span class="type-dot ${activity.type}"></span>${escapeHtml(activity.message)}</div>
    <div class="meta-row"><span>${escapeHtml(activity.project_name || '')}</span><span>${time}</span></div>
  `;
  if (feed.firstChild) feed.insertBefore(item, feed.firstChild);
  else feed.appendChild(item);

  if (animate) {
    el('feed-badge').classList.remove('hidden');
    setTimeout(() => el('feed-badge').classList.add('hidden'), 2000);
  }
}

// ============================================================================
// Modal helper (generic small form modal)
// ============================================================================
function openModal({ title, fields, onConfirm }) {
  el('modal-title').textContent = title;
  const body = el('modal-body');
  body.innerHTML = '';
  fields.forEach((f) => {
    const label = document.createElement('label');
    label.textContent = f.label;
    label.style.fontSize = '12px';
    label.style.color = 'var(--muted)';
    body.appendChild(label);
    const input = f.type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
    if (f.type !== 'textarea') input.type = f.type;
    input.id = f.id;
    body.appendChild(input);
  });
  el('modal-overlay').classList.remove('hidden');

  const confirmBtn = el('modal-confirm');
  const cancelBtn = el('modal-cancel');

  const cleanup = () => {
    el('modal-overlay').classList.add('hidden');
    confirmBtn.replaceWith(confirmBtn.cloneNode(true));
    cancelBtn.replaceWith(cancelBtn.cloneNode(true));
  };

  el('modal-confirm').addEventListener('click', async () => {
    const values = {};
    fields.forEach((f) => (values[f.id] = document.getElementById(f.id).value));
    await onConfirm(values);
    cleanup();
  });
  el('modal-cancel').addEventListener('click', cleanup);
}

// ============================================================================
// Toast helper
// ============================================================================
function showToast(message) {
  const container = el('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ============================================================================
// Utils
// ============================================================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ============================================================================
// Init
// ============================================================================
boot();
