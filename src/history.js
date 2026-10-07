import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppError, validateWorkspace } from './core.js';

export const HISTORY_LIMIT = 50;
const ID_PATTERN = /^[\w-]{1,80}$/;

// Bounded, crash-safe undo history for one workspace. Snapshots hold the full
// workspace *before* each mutation, so restoring is a validated replace.
// The parent performs restores through its normal revision-checked path.
export function createHistory(file, { limit = HISTORY_LIMIT } = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('history file is required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError('history limit must be 1-200');
  let entries = [];
  let queue = Promise.resolve();

  async function persist(next) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, entries: next }, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporary, file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  function checkSnapshot(value) {
    const clean = validateWorkspace(value);
    if (!Number.isSafeInteger(value.revision) || value.revision < 0)
      throw new AppError(400, 'Invalid history revision');
    return { revision: value.revision, ...clean };
  }
  async function init() {
    try {
      const loaded = JSON.parse(await readFile(file, 'utf8'));
      if (!loaded || typeof loaded !== 'object' || loaded.version !== 1 || !Array.isArray(loaded.entries))
        throw new Error('Invalid history file');
      entries = loaded.entries
        .map((entry) => {
          if (
            !entry ||
            typeof entry !== 'object' ||
            Array.isArray(entry) ||
            typeof entry.id !== 'string' ||
            !ID_PATTERN.test(entry.id) ||
            typeof entry.action !== 'string' ||
            !entry.action ||
            entry.action.length > 120 ||
            typeof entry.at !== 'string' ||
            Number.isNaN(Date.parse(entry.at)) ||
            !Number.isSafeInteger(entry.fromRevision) ||
            !Number.isSafeInteger(entry.toRevision)
          ) {
            throw new Error('Invalid history entry');
          }
          return {
            id: entry.id,
            action: entry.action,
            at: entry.at,
            fromRevision: entry.fromRevision,
            toRevision: entry.toRevision,
            snapshot: checkSnapshot(entry.snapshot),
          };
        })
        .slice(-limit);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries = [];
    }
    return history;
  }
  function enqueue(task) {
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending;
  }
  const history = {
    init,
    list() {
      return [...entries].reverse().map(({ snapshot, ...meta }) => ({ ...meta }));
    },
    get(id) {
      if (typeof id !== 'string') throw new AppError(404, 'History entry not found');
      const entry = entries.find((item) => item.id === id);
      if (!entry) throw new AppError(404, 'History entry not found');
      return structuredClone(entry.snapshot);
    },
    record({ before, after, action }) {
      if (typeof action !== 'string' || !action.trim() || action.trim().length > 120)
        return Promise.reject(new AppError(400, 'History action must be 1-120 characters'));
      let snapshot;
      try {
        snapshot = checkSnapshot(before);
      } catch (error) {
        return Promise.reject(error.status ? error : new AppError(400, 'Invalid history snapshot'));
      }
      if (!after || typeof after.revision !== 'number')
        return Promise.reject(new AppError(400, 'History needs the workspace after the change'));
      return enqueue(async () => {
        const entry = {
          id: randomUUID(),
          action: action.trim(),
          at: new Date().toISOString(),
          fromRevision: snapshot.revision,
          toRevision: after.revision,
          snapshot,
        };
        const next = [...entries, entry].slice(-limit);
        await persist(next);
        entries = next;
        return {
          id: entry.id,
          action: entry.action,
          at: entry.at,
          fromRevision: entry.fromRevision,
          toRevision: entry.toRevision,
        };
      });
    },
    clear() {
      return enqueue(async () => {
        await persist([]);
        entries = [];
      });
    },
  };
  return history;
}
