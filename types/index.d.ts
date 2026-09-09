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
}

export interface AuthResponse {
  token: string;
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
 * Extends Connector with real-time socket.io session management.
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