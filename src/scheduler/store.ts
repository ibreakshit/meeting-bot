import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyState, SchedulerState } from './types';
import { isValidBotName, isValidThumbnailId } from './settings';

async function atomicSave(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export class SchedulerStore {
  private state: SchedulerState = emptyState();
  private pending?: SchedulerState;
  private writes: Promise<void> = Promise.resolve();

  constructor(private path: string, private persist = atomicSave) {}

  async load(): Promise<void> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const state = JSON.parse(raw) as SchedulerState;
    if (!state || state.version !== 1 || !Array.isArray(state.accounts) || !Array.isArray(state.calendars) ||
      !state.overrides || typeof state.overrides !== 'object' || !Number.isSafeInteger(state.overrideRevision)) {
      throw new Error('Invalid scheduler state file');
    }
    if (state.botSettings !== undefined && (!state.botSettings || typeof state.botSettings !== 'object' ||
      !isValidBotName(state.botSettings.name) ||
      (state.botSettings.thumbnailId !== undefined && !isValidThumbnailId(state.botSettings.thumbnailId)))) {
      throw new Error('Invalid saved bot settings');
    }
    for (const calendar of state.calendars) {
      if (typeof calendar.id !== 'string' || !Array.isArray(calendar.events)) throw new Error('Invalid calendar state');
      calendar.verified = false;
    }
    for (const account of state.accounts) {
      if (typeof account.id !== 'string' || typeof account.email !== 'string' || typeof account.refreshToken !== 'string') {
        throw new Error('Invalid account state');
      }
    }
    this.state = state;
  }

  read(): SchedulerState { return structuredClone(this.state); }
  get isDirty(): boolean { return this.pending !== undefined; }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => undefined);
    return result;
  }

  update(mutator: (state: SchedulerState) => void | Promise<void>): Promise<void> {
    return this.serialize(async () => {
      const next = structuredClone(this.pending || this.state);
      await mutator(next);
      this.pending = next;
      await this.persist(this.path, JSON.stringify(next));
      this.state = next;
      this.pending = undefined;
    });
  }

  flush(): Promise<void> {
    return this.serialize(async () => {
      if (!this.pending) return;
      await this.persist(this.path, JSON.stringify(this.pending));
      this.state = this.pending;
      this.pending = undefined;
    });
  }
}
