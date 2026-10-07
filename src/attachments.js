import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AppError } from './core.js';

export const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ATTACHMENTS = 4096;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const queues = new Map();

function validId(value, kind) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new AppError(400, `Invalid ${kind} ID`);
  return value;
}
function validAttachmentId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new AppError(400, 'Invalid attachment ID');
  return value;
}
function cleanFilename(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096 || /[/\\\x00-\x1f\x7f]/.test(value))
    throw new AppError(400, 'Invalid PDF filename');
  const name = value.trim();
  if (!/\.pdf$/i.test(name)) throw new AppError(400, 'Filename must end in .pdf');
  const stem = name
    .slice(0, -4)
    .replace(/[^A-Za-z0-9._ ()-]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 116)
    .trim();
  if (!stem || /^\.+$/.test(stem)) throw new AppError(400, 'Invalid PDF filename');
  return `${stem}.pdf`;
}
function pdfBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_PDF_BYTES)
    throw new AppError(413, 'PDF must be at most 15 MiB');
  if (value.byteLength < 5 || Buffer.from(value.buffer, value.byteOffset, 5).toString('ascii') !== '%PDF-')
    throw new AppError(400, 'Invalid PDF signature');
  // Snapshot caller-owned bytes before joining the queue, so callers cannot change a queued upload.
  return Buffer.from(value);
}
function queueFor(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const operation = previous.then(task);
  const settled = operation.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return operation;
}
async function directory(path, create = false) {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (!create && error.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError(500, 'Unsafe attachment directory');
  await chmod(path, 0o700);
  return true;
}
function checkManifest(data) {
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data.version !== 1 ||
    !Array.isArray(data.attachments) ||
    data.attachments.length > MAX_ATTACHMENTS
  )
    throw new AppError(500, 'Invalid attachment manifest');
  const ids = new Set();
  for (const entry of data.attachments) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      !IDENTIFIER.test(entry.nodeId) ||
      !UUID.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.filename !== 'string' ||
      cleanFilenameFromManifest(entry.filename) !== entry.filename ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 5 ||
      entry.size > MAX_PDF_BYTES ||
      entry.contentType !== 'application/pdf' ||
      typeof entry.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(entry.createdAt)) ||
      new Date(entry.createdAt).toISOString() !== entry.createdAt
    ) {
      throw new AppError(500, 'Invalid attachment manifest');
    }
    ids.add(entry.id);
  }
  return data.attachments;
}
function cleanFilenameFromManifest(name) {
  try {
    return cleanFilename(name);
  } catch {
    return null;
  }
}
async function boundedRead(path, limit) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new AppError(500, 'Invalid attachment file');
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new AppError(500, 'Attachment file changed during read');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
async function loadManifest(projectDir) {
  let bytes;
  try {
    bytes = await boundedRead(join(projectDir, 'manifest.json'), MAX_MANIFEST_BYTES);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new AppError(500, 'Invalid attachment manifest');
  }
  return checkManifest(data);
}
async function saveManifest(projectDir, attachments) {
  const path = join(projectDir, 'manifest.json');
  const temporary = join(projectDir, `${randomUUID()}.tmp`);
  const data = Buffer.from(JSON.stringify({ version: 1, attachments }) + '\n');
  if (data.length > MAX_MANIFEST_BYTES) throw new AppError(413, 'Too many attachments');
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
function publicDescriptor(entry) {
  const { id, filename, size, contentType, createdAt } = entry;
  return { id, filename, size, contentType, createdAt };
}
// Sweep only UUID-named PDFs, never arbitrary files or directory trees. A crash
// between writing the blob and publishing its manifest cannot expose an orphan.
async function sweep(projectDir, entries) {
  const live = new Set(entries.map((entry) => `${entry.id}.pdf`));
  for (const name of await readdir(projectDir)) {
    if (UUID.test(name.slice(0, -4)) && name.endsWith('.pdf') && !live.has(name))
      await unlink(join(projectDir, name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
}

// Files and metadata live *outside* the workspace JSON, so JSON backups never
// contain PDF bytes or attachment metadata. The caller chooses a dedicated root.
export async function createAttachmentStore(root) {
  if (typeof root !== 'string' || !root || root.includes('\0')) throw new AppError(400, 'Invalid attachment root');
  const base = resolve(root);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await directory(base);
  const service = {
    async add(projectId, nodeId, { filename, bytes } = {}) {
      const project = validId(projectId, 'project');
      const node = validId(nodeId, 'node');
      const safeName = cleanFilename(filename);
      const data = pdfBytes(bytes);
      const projectDir = join(base, project);
      return queueFor(projectDir, async () => {
        await directory(base);
        await directory(projectDir, true);
        const entries = await loadManifest(projectDir);
        if (entries.length >= MAX_ATTACHMENTS) throw new AppError(413, 'Too many attachments');
        const descriptor = {
          id: randomUUID(),
          filename: safeName,
          size: data.length,
          contentType: 'application/pdf',
          createdAt: new Date().toISOString(),
        };
        const blob = join(projectDir, `${descriptor.id}.pdf`);
        const handle = await open(
          blob,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          try {
            await handle.writeFile(data);
          } finally {
            await handle.close();
          }
          await saveManifest(projectDir, [...entries, { nodeId: node, ...descriptor }]);
        } catch (error) {
          await unlink(blob).catch(() => {});
          throw error;
        }
        await sweep(projectDir, [...entries, { nodeId: node, ...descriptor }]);
        return descriptor;
      });
    },
    async list(projectId, nodeId) {
      const project = validId(projectId, 'project');
      const node = validId(nodeId, 'node');
      const projectDir = join(base, project);
      return queueFor(projectDir, async () => {
        await directory(base);
        if (!(await directory(projectDir))) return [];
        return (await loadManifest(projectDir)).filter((entry) => entry.nodeId === node).map(publicDescriptor);
      });
    },
    async read(projectId, nodeId, id) {
      const project = validId(projectId, 'project');
      const node = validId(nodeId, 'node');
      validAttachmentId(id);
      const projectDir = join(base, project);
      return queueFor(projectDir, async () => {
        await directory(base);
        if (!(await directory(projectDir))) throw new AppError(404, 'Attachment not found');
        const entry = (await loadManifest(projectDir)).find((item) => item.id === id && item.nodeId === node);
        if (!entry) throw new AppError(404, 'Attachment not found');
        let bytes;
        try {
          bytes = await boundedRead(join(projectDir, `${id}.pdf`), MAX_PDF_BYTES);
        } catch (error) {
          if (error.code === 'ENOENT') throw new AppError(500, 'Attachment file missing');
          throw error;
        }
        if (bytes.length !== entry.size || bytes.subarray(0, 5).toString('ascii') !== '%PDF-')
          throw new AppError(500, 'Attachment file corrupted');
        return { descriptor: publicDescriptor(entry), bytes };
      });
    },
    async remove(projectId, nodeId, id) {
      const project = validId(projectId, 'project');
      const node = validId(nodeId, 'node');
      validAttachmentId(id);
      const projectDir = join(base, project);
      return queueFor(projectDir, async () => {
        await directory(base);
        if (!(await directory(projectDir))) throw new AppError(404, 'Attachment not found');
        const entries = await loadManifest(projectDir);
        if (!entries.some((entry) => entry.nodeId === node && entry.id === id))
          throw new AppError(404, 'Attachment not found');
        const remaining = entries.filter((entry) => entry.id !== id);
        await saveManifest(projectDir, remaining); // Never delete a blob while the manifest still references it.
        await unlink(join(projectDir, `${id}.pdf`)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        await sweep(projectDir, remaining);
      });
    },
  };
  // Recover unpublished blobs and interrupted deletions on restart. Project IDs
  // are deliberately checked before constructing paths or touching their files.
  for (const project of await readdir(base)) {
    if (!IDENTIFIER.test(project)) continue;
    const projectDir = join(base, project);
    await queueFor(projectDir, async () => {
      await directory(projectDir);
      await sweep(projectDir, await loadManifest(projectDir));
    });
  }
  return service;
}
