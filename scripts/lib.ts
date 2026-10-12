// Shared by the ledger and export scripts: read a live state directory without touching it.
import { copyFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

// The path with every symlink resolved, even when the tail does not exist yet: resolve the
// nearest existing ancestor for real, then append what is left. "/var/x" and "/private/var/x"
// come out the same, and a symlink into the repo is seen for what it is.
export function canonicalPath(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    tail.unshift(head.slice(dirname(head).length + 1));
    head = dirname(head);
  }
  // .native returns the on-disk spelling, so REPO and repo are the same directory on macOS.
  return join(realpathSync.native(head), ...tail);
}

// True when `child` is `parent` or anywhere below it, after resolving real paths. A name that
// merely starts with two dots ("..household") is a normal child, not an escape.
export function isInside(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
