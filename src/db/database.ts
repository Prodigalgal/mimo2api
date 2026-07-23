import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { AppConfigSchema, MimoAccountSchema, type AppConfig, type MimoAccount } from "../config/types.js";

const accountColumns = [
  "service_token", "user_id", "xiaomichatbot_ph", "login_time", "last_test",
  "email", "password", "pass_token", "c_user_id", "device_id", "last_renew",
  "renew_error", "mail_jwt", "region",
] as const;

export class AppDatabase {
  readonly connection: Database.Database;

  private constructor(file: string) {
    this.connection = new Database(file);
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
    this.migrate();
  }

  static async open(file = databasePath()): Promise<AppDatabase> {
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    return new AppDatabase(path.resolve(file));
  }

  migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position INTEGER NOT NULL,
        renew_key TEXT NOT NULL UNIQUE,
        service_token TEXT NOT NULL,
        user_id TEXT NOT NULL,
        xiaomichatbot_ph TEXT NOT NULL,
        login_time TEXT NOT NULL DEFAULT '',
        last_test TEXT NOT NULL DEFAULT '',
        is_valid INTEGER NOT NULL DEFAULT 0,
        email TEXT NOT NULL DEFAULT '',
        password TEXT NOT NULL DEFAULT '',
        pass_token TEXT NOT NULL DEFAULT '',
        c_user_id TEXT NOT NULL DEFAULT '',
        device_id TEXT NOT NULL DEFAULT '',
        auto_renew INTEGER NOT NULL DEFAULT 1,
        last_renew TEXT NOT NULL DEFAULT '',
        renew_error TEXT NOT NULL DEFAULT '',
        mail_jwt TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        extra_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_position_idx ON accounts(position);
      CREATE INDEX IF NOT EXISTS accounts_user_idx ON accounts(user_id);
      CREATE TABLE IF NOT EXISTS account_renewals (
        account_key TEXT PRIMARY KEY,
        next_renew_at INTEGER NOT NULL,
        lease_until INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS account_renewals_due_idx ON account_renewals(next_renew_at, lease_until);
      CREATE TABLE IF NOT EXISTS temp_mail_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proxy_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        background INTEGER NOT NULL DEFAULT 0,
        response_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS responses_expires_idx ON responses(expires_at);
      CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL,
        model TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(day, model)
      );
    `);
  }

  async importLegacyConfig(file: string): Promise<boolean> {
    if (this.meta("legacy_config_imported")) return false;
    let config: AppConfig;
    try {
      config = AppConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") config = AppConfigSchema.parse({});
      else throw error;
    }
    const hasSettings = Number((this.connection.prepare("SELECT COUNT(*) count FROM settings").get() as { count: number }).count) > 0;
    if (!hasSettings) this.writeConfig(config);
    this.setMeta("legacy_config_imported", JSON.stringify({ source: path.resolve(file), at: new Date().toISOString() }));
    return !hasSettings;
  }

  readConfig(): AppConfig {
    const settings = Object.fromEntries(
      (this.connection.prepare("SELECT key, value_json FROM settings").all() as Array<{ key: string; value_json: string }>)
        .map((row) => [row.key, JSON.parse(row.value_json)]),
    );
    const accounts = (this.connection.prepare("SELECT * FROM accounts ORDER BY position").all() as AccountRow[]).map(rowToAccount);
    const temp = this.connection.prepare("SELECT config_json FROM temp_mail_config WHERE id = 1").get() as { config_json: string } | undefined;
    const proxy = this.connection.prepare("SELECT config_json FROM proxy_config WHERE id = 1").get() as { config_json: string } | undefined;
    return AppConfigSchema.parse({
      ...settings,
      mimo_accounts: accounts,
      temp_mail: temp ? JSON.parse(temp.config_json) : {},
      proxy_pool: proxy ? JSON.parse(proxy.config_json) : {},
    });
  }

  writeConfig(config: AppConfig): void {
    const transaction = this.connection.transaction(() => {
      const now = Date.now();
      const setting = this.connection.prepare(`
        INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `);
      for (const key of ["api_keys", "admin_password", "models", "tools_passthrough", "captcha_ai"] as const) {
        setting.run(key, JSON.stringify(config[key]), now);
      }
      this.connection.prepare(`
        INSERT INTO temp_mail_config(id, config_json, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
      `).run(JSON.stringify(config.temp_mail), now);
      this.connection.prepare(`
        INSERT INTO proxy_config(id, config_json, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
      `).run(JSON.stringify(config.proxy_pool), now);
      this.replaceAccounts(config.mimo_accounts);
    });
    transaction();
  }

  replaceAccounts(accounts: MimoAccount[]): void {
    const replace = this.connection.transaction(() => {
      this.connection.prepare("DELETE FROM accounts").run();
      const insert = this.connection.prepare(`
        INSERT INTO accounts(
          position, renew_key, service_token, user_id, xiaomichatbot_ph, login_time, last_test,
          is_valid, email, password, pass_token, c_user_id, device_id, auto_renew,
          last_renew, renew_error, mail_jwt, region, extra_json
        ) VALUES (
          @position, @renew_key, @service_token, @user_id, @xiaomichatbot_ph, @login_time, @last_test,
          @is_valid, @email, @password, @pass_token, @c_user_id, @device_id, @auto_renew,
          @last_renew, @renew_error, @mail_jwt, @region, @extra_json
        )
      `);
      const now = Date.now();
      const spread = Math.max(60_000, Number(process.env.MIMO2API_RENEW_INITIAL_SPREAD_SECONDS ?? 3_600) * 1_000);
      const schedule = this.connection.prepare(`
        INSERT INTO account_renewals(account_key, next_renew_at, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(account_key) DO NOTHING
      `);
      accounts.forEach((account, position) => {
        const row = accountToRow(account, position);
        insert.run(row);
        if (account.auto_renew && account.pass_token) {
          schedule.run(row.renew_key, now + stableOffset(String(row.renew_key), spread), now);
        }
      });
      this.connection.prepare("DELETE FROM account_renewals WHERE account_key NOT IN (SELECT renew_key FROM accounts)").run();
    });
    replace();
  }

  claimRenewal(now: number, leaseMs: number): { key: string; account: MimoAccount; attempts: number } | undefined {
    return this.connection.transaction(() => {
      const row = this.connection.prepare(`
        SELECT a.*, r.attempts renewal_attempts FROM account_renewals r
        JOIN accounts a ON a.renew_key = r.account_key
        WHERE r.next_renew_at <= ? AND r.lease_until <= ? AND a.auto_renew = 1 AND a.pass_token <> ''
        ORDER BY r.next_renew_at ASC LIMIT 1
      `).get(now, now) as AccountRow | undefined;
      if (!row) return undefined;
      const updated = this.connection.prepare(`
        UPDATE account_renewals SET lease_until = ?, updated_at = ?
        WHERE account_key = ? AND lease_until <= ?
      `).run(now + leaseMs, now, row.renew_key, now);
      return updated.changes === 1
        ? { key: row.renew_key, account: rowToAccount(row), attempts: Number(row.renewal_attempts ?? 0) }
        : undefined;
    })();
  }

  completeRenewal(key: string, account: MimoAccount, nextRenewAt: number): void {
    this.connection.transaction(() => {
      this.connection.prepare(`
        UPDATE accounts SET
          service_token = @service_token, user_id = @user_id, xiaomichatbot_ph = @xiaomichatbot_ph,
          pass_token = @pass_token, c_user_id = @c_user_id, device_id = @device_id,
          last_renew = @last_renew, renew_error = '', is_valid = 1
        WHERE renew_key = @renew_key
      `).run({ ...account, renew_key: key });
      this.connection.prepare(`
        UPDATE account_renewals SET next_renew_at = ?, lease_until = 0, attempts = 0,
          last_error = '', updated_at = ? WHERE account_key = ?
      `).run(nextRenewAt, Date.now(), key);
    })();
  }

  failRenewal(key: string, error: string, nextRenewAt: number): void {
    this.connection.transaction(() => {
      const now = Date.now();
      this.connection.prepare(`
        UPDATE accounts SET last_renew = ?, renew_error = ?, is_valid = 0 WHERE renew_key = ?
      `).run(new Date(now).toISOString(), error.slice(0, 500), key);
      this.connection.prepare(`
        UPDATE account_renewals SET next_renew_at = ?, lease_until = 0, attempts = attempts + 1,
          last_error = ?, updated_at = ? WHERE account_key = ?
      `).run(nextRenewAt, error.slice(0, 500), now, key);
    })();
  }

  renewalStatus(): { due: number; leased: number; nextAt: number | null; failed: number } {
    const now = Date.now();
    const row = this.connection.prepare(`
      SELECT
        SUM(CASE WHEN next_renew_at <= @now AND lease_until <= @now THEN 1 ELSE 0 END) due,
        SUM(CASE WHEN lease_until > @now THEN 1 ELSE 0 END) leased,
        MIN(next_renew_at) next_at,
        SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) failed
      FROM account_renewals
    `).get({ now }) as { due: number | null; leased: number | null; next_at: number | null; failed: number | null };
    return { due: row.due ?? 0, leased: row.leased ?? 0, nextAt: row.next_at, failed: row.failed ?? 0 };
  }

  enqueueAllRenewals(spreadMs: number): number {
    const rows = this.connection.prepare(`
      SELECT renew_key FROM accounts WHERE auto_renew = 1 AND pass_token <> '' ORDER BY position
    `).all() as Array<{ renew_key: string }>;
    const now = Date.now();
    const update = this.connection.prepare(`
      UPDATE account_renewals SET next_renew_at = ?, lease_until = 0, updated_at = ? WHERE account_key = ?
    `);
    this.connection.transaction(() => rows.forEach((row, index) => {
      const offset = rows.length > 1 ? Math.round((spreadMs * index) / (rows.length - 1)) : 0;
      update.run(now + offset, now, row.renew_key);
    }))();
    return rows.length;
  }

  meta(key: string): string | undefined {
    return (this.connection.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.connection.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  close(): void {
    this.connection.close();
  }
}

interface AccountRow extends Record<string, unknown> {
  position: number;
  renew_key: string;
  renewal_attempts?: number;
  service_token: string;
  user_id: string;
  xiaomichatbot_ph: string;
  login_time: string;
  last_test: string;
  is_valid: number;
  email: string;
  password: string;
  pass_token: string;
  c_user_id: string;
  device_id: string;
  auto_renew: number;
  last_renew: string;
  renew_error: string;
  mail_jwt: string;
  region: string;
  extra_json: string;
}

const accountToRow = (account: MimoAccount, position: number): Record<string, unknown> => {
  const known = new Set<string>([...accountColumns, "is_valid", "auto_renew"]);
  const extra = Object.fromEntries(Object.entries(account).filter(([key]) => !known.has(key)));
  return {
    position,
    renew_key: renewalKey(account),
    ...Object.fromEntries(accountColumns.map((key) => [key, String(account[key] ?? "")])),
    is_valid: account.is_valid ? 1 : 0,
    auto_renew: account.auto_renew ? 1 : 0,
    extra_json: JSON.stringify(extra),
  };
};

const rowToAccount = (row: AccountRow): MimoAccount => MimoAccountSchema.parse({
  ...JSON.parse(row.extra_json),
  ...Object.fromEntries(accountColumns.map((key) => [key, row[key]])),
  is_valid: Boolean(row.is_valid),
  auto_renew: Boolean(row.auto_renew),
});

const renewalKey = (account: MimoAccount): string => createHash("sha256")
  .update(account.user_id || account.email || account.service_token)
  .digest("hex");

const stableOffset = (key: string, spreadMs: number): number => (
  Number.parseInt(key.slice(0, 8), 16) % spreadMs
);

const databasePath = (): string => {
  if (process.env.MIMO2API_DATABASE_FILE) return process.env.MIMO2API_DATABASE_FILE;
  const dataDir = process.env.MIMO2API_DATA_DIR;
  return dataDir ? path.join(dataDir, "mimo2api.sqlite") : "mimo2api.sqlite";
};
