// Ring token records, kept outside the repo (secrets) as one 0600 JSON file.
// Writes go to a temp file and rename into place so a crash never leaves half a file.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TokenRecord {
  account_id: string;
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_at: number; // epoch ms
  issued_at: number; // epoch ms
  claimed: boolean;
  claimed_at?: number;
  integration_status?: 'awaiting' | 'completed';
}

export interface StoreData {
  tokens: TokenRecord[];
}

export class TokenStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  read(): StoreData {
    if (!existsSync(this.path)) return { tokens: [] };
    return JSON.parse(readFileSync(this.path, 'utf8')) as StoreData;
  }

  private write(data: StoreData): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  // One record per Ring account: a re-link replaces the old tokens.
  upsert(record: TokenRecord): void {
    const data = this.read();
    data.tokens = data.tokens.filter((t) => t.account_id !== record.account_id);
    data.tokens.push(record);
    this.write(data);
  }

  update(accountId: string, patch: Partial<TokenRecord>): TokenRecord | undefined {
    const data = this.read();
    const rec = data.tokens.find((t) => t.account_id === accountId);
    if (!rec) return undefined;
    Object.assign(rec, patch);
    this.write(data);
    return rec;
  }

  unclaimed(): TokenRecord[] {
    return this.read().tokens.filter((t) => !t.claimed);
  }

  all(): TokenRecord[] {
    return this.read().tokens;
  }
}
