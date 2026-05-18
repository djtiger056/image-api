import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { tokenSplit } from '@/api/controllers/core.ts';
import { resolveServiceAuthorization } from '@/lib/service-authorization.js';
import { createCompletion, createCompletionStream } from '@/api/controllers/chat.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.model', v => _.isUndefined(v) || _.isString(v))
                .validate('body.messages', _.isArray)
            const authorization = resolveServiceAuthorization(request.headers.authorization as string | undefined);
            const tokens = tokenSplit(authorization);
            // 随机挑选一个refresh_token
            const token = _.sample(tokens);
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