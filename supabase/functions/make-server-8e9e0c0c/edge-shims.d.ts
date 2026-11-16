declare namespace Deno {
  const env: {
    get(name: string): string | undefined;
  };
  function serve(handler: unknown): void;
}

type EdgeContext = {
  req: {
    header(name: string): string | undefined;
    query(name: string): string | undefined;
    param(name: string): string;
    json(): Promise<any>;
    formData(): Promise<FormData>;
    arrayBuffer(): Promise<ArrayBuffer>;
  };
  json(data: unknown, status?: number): Response;
  header(name: string, value: string): void;
};

type EdgeHandler = (c: EdgeContext, ...rest: any[]) => unknown;

declare module "npm:hono" {
  export class Hono {
    use(...args: any[]): this;
    get(path: string, ...handlers: EdgeHandler[]): this;
    post(path: string, ...handlers: EdgeHandler[]): this;
    put(path: string, ...handlers: EdgeHandler[]): this;
    delete(path: string, ...handlers: EdgeHandler[]): this;
    onError(handler: (error: unknown, c: EdgeContext) => unknown): this;
    fetch: unknown;
  }
}

declare module "npm:hono/cors" {
  export function cors(options?: Record<string, unknown>): EdgeHandler;
}

declare module "npm:hono/logger" {
  export function logger(write?: (...args: any[]) => void): EdgeHandler;
}

type KvRow = { key?: string; value: any };
type KvResult<T> = Promise<{ data: T; error: { message: string } | null }>;
type KvQuery = {
  upsert(values: unknown): KvResult<null>;
  select(columns: string): {
    eq(
      column: string,
      value: string,
    ): {
      maybeSingle(): KvResult<KvRow | null>;
    };
    in(column: string, values: string[]): KvResult<KvRow[] | null>;
    like(column: string, pattern: string): KvResult<KvRow[] | null>;
  };
  delete(): {
    eq(column: string, value: string): KvResult<null>;
    in(column: string, values: string[]): KvResult<null>;
  };
};

declare module "jsr:@supabase/supabase-js@2.49.8" {
  export function createClient(
    url: string | undefined,
    key: string | undefined,
  ): {
    from(table: string): KvQuery;
    storage: {
      getBucket(name: string): Promise<any>;
      updateBucket(name: string, options: unknown): Promise<any>;
      createBucket(name: string, options: unknown): Promise<any>;
      from(bucket: string): {
        list(prefix?: string): Promise<{ data: { name: string }[] | null }>;
        remove(paths: string[]): Promise<any>;
        createSignedUrl(path: string, expiresIn: number): Promise<any>;
        upload(path: string, body: unknown, options?: unknown): Promise<any>;
      };
    };
  };
}

declare module "npm:web-push@3.6.7" {
  export function generateVAPIDKeys(): any;
  export function setVapidDetails(...args: any[]): void;
  export function sendNotification(...args: any[]): Promise<any>;
  const webPush: any;
  export default webPush;
}

declare module "npm:livekit-server-sdk@2" {
  export class AccessToken {
    constructor(apiKey: string, apiSecret: string, options?: unknown);
    addGrant(grant: unknown): void;
    toJwt(): Promise<string>;
  }
  export class RoomServiceClient {
    constructor(url: string, apiKey: string, apiSecret: string);
    listParticipants(room: string): Promise<{ identity: string }[]>;
    deleteRoom(room: string): Promise<void>;
  }
}
