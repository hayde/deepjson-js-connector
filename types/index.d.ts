// types/index.d.ts

export interface ClientConfig {
  baseURL:  string;
  token?:   string | null;
  storage?: 'memory' | string;
  timeout?: number;
  /**
   * Called with the fresh token whenever the server renews the session via the
   * `X-Renewed-Token` response header. The connector already stores the new
   * token itself; use this hook to persist it (localStorage, keychain, ...).
   */
  onTokenRenewed?: (token: string) => void;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /**
   * Supply a WebSocket implementation. Browsers and Node 22+ have one built
   * in; on older Node pass e.g. the `ws` package, or run the process with
   * --experimental-websocket. Realtime only.
   */
  WebSocket?: unknown;
  /**
   * Use socket.io-client instead of the built-in protocol client, e.g.
   * `io: require('socket.io-client').io`. Only needed for transports the
   * built-in client does not implement (HTTP long-polling fallback).
   */
  io?: (url: string, opts: { query: Record<string, unknown> }) => unknown;
}

export interface AuthResponse {
  token: string;
  [key: string]: unknown;
}

/** Effective permissions for one key, as resolved by the server. */
export interface KeyPermissions {
  C: boolean;
  R: boolean;
  U: boolean;
  D: boolean;
  X: boolean;
}

export interface VersionResponse {
  version: string;
  [key: string]: unknown;
}

export interface WhoamiResponse {
  version: string;
  authenticated: boolean;
  user: { id: string; email?: string };
  groups: string[];
  isAdmin: boolean;
  /**
   * For display and debugging only - always accompanied by
   * `rulesAreAdvisory: true`. The server evaluates rules in order with
   * last-match-wins, so a client that reimplements "any matching rule grants
   * it" will disagree with it. Use `permissions` for anything load-bearing.
   */
  rules: Array<{ group: string; regex: string; crudx: string }>;
  rulesAreAdvisory: boolean;
  /** Present only when keys were requested. */
  permissions?: Record<string, KeyPermissions>;
  [key: string]: unknown;
}

/**
 * Body of a 412 Precondition Failed response. The thrown error also carries
 * `status` (412) and `etag` (the server's current version).
 */
export interface PreconditionFailed {
  error: string;
  /** The value that was sent in If-Match, when that was the failing header. */
  expected?: string;
  /** The version the server actually holds, or null if the key is absent. */
  current: string | null;
}

/** Paging / counting options for listKeys(). */
export interface ListKeysOptions {
  /** Maximum keys to return. The server may clamp this to `key_list_limit`. */
  limit?: number;
  /** Zero-based index of the first key to return. */
  offset?: number;
  /** Return only `total`, with no key list. */
  count?: boolean;
}

export interface ListKeysResult {
  /** Full number of matches, independent of any paging. */
  total: number;
  /** The page of key names. Absent when `count: true` was requested. */
  keys?: string[];
  /** Echoed back when the result is paged. */
  offset?: number;
  /** The limit actually applied - may be the server's `key_list_limit`. */
  limit?: number;
  /** True when keys beyond this page remain. Check it before assuming `keys` is complete. */
  truncated?: boolean;
}

export interface RequestOptions {
  overwrite?: boolean;
}

/**
 * HTTP connector for DeepJSON Server.
 * Handles key-value CRUD, file upload, and key listing.
 */
export class Connector {
  constructor(config: ClientConfig);

  // Auth
  login(username: string, password: string): Promise<AuthResponse>;
  getToken(): string | null;
  /** Restores a previously persisted token for subsequent requests. */
  setToken(token: string | null): this;

  // Identity and build info (both authenticated, both renew the token)
  /** GET /version - also usable as a heartbeat / token-validity check. */
  version(): Promise<VersionResponse>;
  /** GET /whoami - pass keys to have the server resolve their permissions. */
  whoami(keys?: string | string[]): Promise<WhoamiResponse>;

  // Flags (chainable setters)
  isBinary(): boolean;
  setBinary(value: boolean): this;
  isOverwriteKey(): boolean;
  setOverwriteKey(value: boolean): this;

  // Optimistic concurrency
  /**
   * ETag of the most recent response, or null if it carried none. Set on
   * reads, on writes (the version just written) and on a 412.
   */
  getETag(): string | null;
  /**
   * Sends If-Match on the next request only: the write proceeds only while the
   * key is still at this version, else the server answers 412. '*' means
   * "only if the key exists".
   */
  setIfMatch(etag: string | null): this;
  /**
   * Sends If-None-Match on the next request only. '*' is a conditional create,
   * failing with 412 if the key already exists. If-Match wins if both are set.
   */
  setIfNoneMatch(etag: string | null): this;

  // CRUD
  get(key: string, value?: unknown, script?: string): Promise<unknown>;
  post(key: string, value: unknown, script?: string): Promise<unknown>;
  put(key: string, value: unknown, script?: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  move(key: string, keyTo: string): Promise<unknown>;

  // Files & keys
  uploadFile(key: string, file: File | string, options?: RequestOptions): Promise<unknown>;
  /**
   * Lists key names from the in-memory index. `total` is always the full
   * match count, so it can exceed `keys.length` - and `truncated` can be true
   * even for an unpaged call, because an operator can cap every listing with
   * `key_list_limit` in the server config.
   */
  listKeys(filters?: string | RegExp, options?: ListKeysOptions): Promise<ListKeysResult>;
}

/**
 * Minimal socket.io v4 protocol client over a native WebSocket. Used by
 * SyncConnector by default; exported for direct use and testing.
 */
export class DeepJSONSocket {
  constructor(baseURL: string, opts?: {
    query?: Record<string, unknown>;
    path?: string;
    reconnection?: boolean;
    reconnectionDelay?: number;
    reconnectionAttempts?: number;
    WebSocket?: unknown;
  });
  readonly connected: boolean;
  io: { opts: { query: Record<string, unknown> } };
  on(event: string, handler: (...args: any[]) => void): this;
  off(event: string, handler?: (...args: any[]) => void): this;
  emit(event: string, ...args: unknown[]): this;
  disconnect(): this;
}

/**
 * Extends Connector with real-time session management, speaking the
 * socket.io v4 protocol over a native WebSocket.
 */
export class SyncConnector extends Connector {
  constructor(config: ClientConfig);

  // Session
  createSession(): Promise<string>;          // resolves with channelId
  joinSession(channelId: string): Promise<unknown>;
  disconnect(): void;
  reconnect(): Promise<unknown> | undefined;

  // Messaging
  on(eventName: string, callback: (...args: unknown[]) => void): void;
  off(eventName: string, callback: (...args: unknown[]) => void): void;
  send(type: string, data: unknown): void;
}

// Aliases matching the UMD global names
export { Connector   as DeepJSONConnector     };
export { SyncConnector as DeepJSONSyncConnector };

// Factory helpers
export function createConnector(config: ClientConfig): Connector;
export function createSyncConnector(config: ClientConfig): SyncConnector;

// Default export for ESM consumers who prefer: import DeepJSON from 'deepjson-connector'
declare const _default: {
  Connector:             typeof Connector;
  SyncConnector:         typeof SyncConnector;
  DeepJSONConnector:     typeof Connector;
  DeepJSONSyncConnector: typeof SyncConnector;
  createConnector:       typeof createConnector;
  createSyncConnector:   typeof createSyncConnector;
};
export default _default;