// Type declarations for Node 24's built-in SQLite module (experimental)
// Reference: https://nodejs.org/api/sqlite.html

declare module "node:sqlite" {
  export interface DatabaseSyncOptions {
    open?: boolean | undefined;
    enableWAL?: boolean | undefined;
  }

  export class StatementSync {
    run(...params: unknown[]): void;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
