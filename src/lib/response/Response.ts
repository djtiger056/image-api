import mime from 'mime';
import _ from 'lodash';

import Body from './Body.ts';
import util from '../util.ts';

export interface ResponseOptions {
    statusCode?: number;
    type?: string;
    headers?: Record<string, any>;
    redirect?: string;
    body?: any;
    size?: number;
    time?: number;
}

export default class Response {

    /** 响应HTTP状态码 */
    statusCode: number;
    /** 响应内容类型 */
    type: string;
    /** 响应headers */
    headers: Record<string, any>;
    /** 重定向目标 */
    redirect: string;
    /** 响应载荷 */
    body: any;
    /** 响应载荷大小 */
    size: number;
    /** 响应时间戳 */
    time: number;

    constructor(body: any, options: ResponseOptions = {}) {
        const { statusCode, type, headers, redirect, size, time } = options;
        this.statusCode = Number(_.defaultTo(statusCode, Body.isInstance(body) ? body.statusCode : undefined))
        this.type = type;
        this.headers = headers;
        this.redirect = redirect;
        this.size = size;
        this.time = Number(_.defaultTo(time, util.timestamp()));
        this.body = body;
    }

    injectTo(ctx) {
        this.redirect && ctx.redirect(this.redirect);
        this.statusCode && (ctx.status = this.statusCode);
        // mime v4 ESM/CJS interop: handle both default export and module namespace
        if (this.type) {
            const m = mime as any;
            const resolvedType = (typeof m.getType === 'function' ? m.getType(this.type) : null)
                || (m.default && typeof m.default.getType === 'function' ? m.default.getType(this.type) : null)
                || this.type;
            ctx.type = resolvedType;
        }
        const headers = this.headers || {};
        if(this.size && !headers["Content-Length"] && !headers["content-length"])
            headers["Content-Length"] = this.size;
        ctx.set(headers);
        if(Body.isInstance(this.body))
            ctx.body = this.body.toObject();
        else
            ctx.body = this.body;
    }

    static isInstance(value) {
        return value instanceof Response;
    }

}