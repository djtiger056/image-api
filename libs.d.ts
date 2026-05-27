declare module "https-proxy-agent" {
  export class HttpsProxyAgent {
    constructor(proxy: string | URL, options?: any);
  }
}

declare module "socks-proxy-agent" {
  export class SocksProxyAgent {
    constructor(proxy: string | URL, options?: any);
  }
}

declare module "koa" {
  export interface BaseRequest {
    body?: any;
    files?: any;
    [key: string]: any;
  }

  export interface Request extends BaseRequest {}

  export interface Context {
    request: Request;
    req: any;
    res: any;
    method: string;
    path: string;
    headers: any;
    body?: any;
    status?: number;
    type?: string;
    is(...types: string[]): string | false | null;
    [key: string]: any;
  }

  export type Next = () => Promise<any>;
  export type Middleware<StateT = any, ContextT = Context> = (
    ctx: ContextT,
    next: Next
  ) => any;

  export default class Koa {
    constructor(options?: any);
    use(middleware: Middleware<any, any>): this;
    listen(...args: any[]): any;
    callback(): any;
  }
}
