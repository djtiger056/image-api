import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import { resolveServiceAuthorization, selectSingleToken } from '@/lib/service-authorization.js';
import { createCompletion, createCompletionStream } from '@/api/controllers/chat.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
            // 按优先级选择单个 token (请求头优先，否则走账号管理器)
            const incomingAuth = String(request.headers.authorization || '').trim();
            let token: string;
            if (incomingAuth) {
                const tokens = tokenSplit(resolveServiceAuthorization(incomingAuth));
                token = tokens[0];
            } else {
                token = selectSingleToken(undefined, 'jimeng');
            }
            const { model, messages, stream } = request.body;
            if (stream) {
                const stream = await createCompletionStream(messages, token, model);
                return new Response(stream, {
                    type: "text/event-stream"
                });
            }
            else
                return await createCompletion(messages, token, model);
        }

    }

}