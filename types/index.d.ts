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

  // CRUD
  get(key: string, value?: unknown, script?: string): Promise<unknown>;
  post(key: string, value: unknown, script?: string): Promise<unknown>;
  put(key: string, value: unknown, script?: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  move(key: string, keyTo: string): Promise<unknown>;

  // Files & keys
  uploadFile(key: string, file: File | string, options?: RequestOptions): Promise<unknown>;
  listKeys(filters?: string | RegExp): Promise<unknown>;
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