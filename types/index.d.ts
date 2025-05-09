// types/index.d.ts
declare module 'deepjson-connector' {
    export class Connector {
      constructor(config: ClientConfig);
      login(username: string, password: string): Promise<AuthResponse>;
      // ... other methods
    }
  }