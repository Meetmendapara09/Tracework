import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AppError, createStore } from './core.js';

const DEFAULT_ID = 'default';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function projectId(id) {
  if (typeof id !== 'string' || (id !== DEFAULT_ID && !UUID.test(id))) throw new AppError(400, 'Invalid project ID');
  return id;
}

function projectName(name) {
  if (typeof name !== 'string') throw new AppError(400, 'Invalid project name');
  const clean = name.trim();
  if (!clean || clean.length > 100 || /[\x00-\x1f\x7f]/.test(clean))
    throw new AppError(400, 'Project name must be 1-100 characters without control characters');
  return clean;
}

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function loadIndex(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== 'projects') ||
    !Array.isArray(input.projects)
  )
    throw new Error('Invalid project index');
  const seen = new Set();
  for (const project of input.projects) {
    if (
      !project ||
      typeof project !== 'object' ||
      Array.isArray(project) ||
      Object.keys(project).some((key) => !['id', 'name', 'createdAt', 'updatedAt', 'archived'].includes(key)) ||
      typeof project.id !== 'string' ||
      (project.id !== DEFAULT_ID && !UUID.test(project.id)) ||
      seen.has(project.id) ||
      typeof project.name !== 'string' ||
      projectName(project.name) !== project.name ||
      !validTimestamp(project.createdAt) ||
      !validTimestamp(project.updatedAt) ||
      (project.archived !== undefined && typeof project.archived !== 'boolean')
    )
      throw new Error('Invalid project index');
    seen.add(project.id);
  }
  if (!seen.has(DEFAULT_ID)) throw new Error('Project index is missing the default project');
  return input.projects;
}

// Write a complete replacement beside the index, then switch it into place.
// Never truncate the live index: a failed write leaves the previous version intact.
async function persistIndex(file, projects) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ projects }, null, 2) + '\n');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    // On systems that support directory sync, also make the rename durable.
    const directory = await open(dir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function createProjectManager({ dataFile, initial } = {}) {
  if (typeof dataFile !== 'string' || !dataFile) throw new TypeError('dataFile is required');
  const workspaceFile = resolve(dataFile);
  const dir = dirname(workspaceFile);
  if (basename(workspaceFile) === 'projects.json') throw new TypeError('dataFile cannot be projects.json');
  const indexFile = join(dir, 'projects.json');
  const projectDir = join(dir, 'projects');
  let projects;
  try {
    projects = loadIndex(JSON.parse(await readFile(indexFile, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const now = new Date().toISOString();
    projects = [{ id: DEFAULT_ID, name: 'Default', createdAt: now, updatedAt: now }];
    await persistIndex(indexFile, projects);
  }

  const stores = new Map();
  let queue = Promise.resolve();
  function enqueue(action) {
    const pending = queue.then(action);
    queue = pending.catch(() => {});
    return pending;
  }
  function find(id) {
    projectId(id);
    const project = projects.find((item) => item.id === id);
    if (!project) throw new AppError(404, 'Project not found');
    return project;
  }
  function getStore(id) {
    find(id);
    if (!stores.has(id)) {
      const file = id === DEFAULT_ID ? workspaceFile : join(projectDir, `${id}.json`);
      const pending = (id === DEFAULT_ID ? createStore(file, initial) : createStore(file)).init();
      stores.set(id, pending);
      pending.catch(() => {
        if (stores.get(id) === pending) stores.delete(id);
      });
    }
    return stores.get(id);
  }
  async function change(id, update) {
    return enqueue(async () => {
      const project = find(id);
      const next = { ...project, ...update, updatedAt: new Date().toISOString() };
      const updated = projects.map((item) => (item.id === id ? next : item));
      await persistIndex(indexFile, updated);
      projects = updated;
      return { ...next };
    });
  }

  return {
    defaultId: DEFAULT_ID,
    fileFor(id) {
      find(id);
      return id === DEFAULT_ID ? workspaceFile : join(projectDir, `${id}.json`);
    },
    list() {
      return projects.map((project) => ({ ...project }));
    },
    getStore,
    async create(name) {
      const clean = projectName(name);
      return enqueue(async () => {
        const id = randomUUID();
        const now = new Date().toISOString();
        const project = { id, name: clean, createdAt: now, updatedAt: now };
        const file = join(projectDir, `${id}.json`);
        // Make the workspace usable before advertising it in the index. If the
        // index write fails, leave its orphaned data alone rather than deleting it.
        const store = await createStore(file).init();
        const updated = [...projects, project];
        await persistIndex(indexFile, updated);
        projects = updated;
        stores.set(id, Promise.resolve(store));
        return { ...project };
      });
    },
    rename(id, name) {
      return change(id, { name: projectName(name) });
    },
    archive(id, archived = true) {
      if (typeof archived !== 'boolean') return Promise.reject(new AppError(400, 'Invalid archived flag'));
      return change(id, { archived });
    },
  };
}
