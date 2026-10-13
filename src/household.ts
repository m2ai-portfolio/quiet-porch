// A device cannot be silently reassigned to another household. Secondary accounts are ledger-only.
import type { DatabaseSync } from 'node:sqlite';
export function householdAccess(
  db: DatabaseSync,
  account: string,
  device: string,
  mapped: boolean,
  configuredPrimary?: string,
): 'primary' | 'ledger_only' | 'unmapped' | 'mismatch' {
  if (!mapped) return 'unmapped';
  db.exec(`CREATE TABLE IF NOT EXISTS household_devices (device_id TEXT PRIMARY KEY, account_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS primary_household (singleton INTEGER PRIMARY KEY CHECK(singleton=1), account_id TEXT NOT NULL);`);
  const bound = db
    .prepare('SELECT account_id FROM household_devices WHERE device_id=?')
    .get(device) as { account_id: string } | undefined;
  if (bound && bound.account_id !== account) return 'mismatch';
  db.prepare('INSERT OR IGNORE INTO household_devices VALUES (?, ?)').run(device, account);
  // No configured primary means every household is ledger-only, even if an earlier run
  // persisted one: removing primaryAccountId must take actuation away, not leave it behind.
  if (!configuredPrimary) return 'ledger_only';
  db.prepare('INSERT OR IGNORE INTO primary_household VALUES (1, ?)').run(configuredPrimary);
  if (primaryHousehold(db) !== configuredPrimary) return 'mismatch';
  return configuredPrimary === account ? 'primary' : 'ledger_only';
}
export function primaryHousehold(db: DatabaseSync): string | undefined {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='primary_household'").get();
  if (!exists) return undefined;
  return (
    db.prepare('SELECT account_id FROM primary_household WHERE singleton=1').get() as
      { account_id: string } | undefined
  )?.account_id;
}
