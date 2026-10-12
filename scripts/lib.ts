// Shared by the ledger and export scripts: read a live state directory without touching it.
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';

export const DEFAULT_STATE_DIR = join(homedir(), '.local/state/quiet-porch');

// Opens a COPY of the live database (and its WAL files), so reading never writes to the
// running service's file, and an older schema is brought up to date on the copy only.
export function openDbCopy(stateDir: string): DatabaseSync {
  const src = join(stateDir, 'quiet-porch.db');
  if (!existsSync(src)) throw new Error(`no database at ${src}`);
  const dir = mkdtempSync(join(tmpdir(), 'qp-copy-'));
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(src + ext)) copyFileSync(src + ext, join(dir, `quiet-porch.db${ext}`));
  }
  return openDb(join(dir, 'quiet-porch.db'));
}

export function arg(name: string, argv = process.argv): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function configPath(): string {
  const real = join(import.meta.dirname, '../config/quiet-porch.json');
  return existsSync(real) ? real : join(import.meta.dirname, '../config/quiet-porch.example.json');
}
