import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { getTokenLiveStatus, getCredit, tokenSplit } from '@/api/controllers/core.ts';
import { getCredit as getXyqCredit, tokenSplit as xyqTokenSplit } from '@/providers/xyq/api.ts';
import { resolveServiceAuthorization } from '@/lib/service-authorization.js';
import logger from '@/lib/logger.ts';

export default {

    prefix: '/token',

    post: {

        '/check': async (request: Request) => {
            request
                .validate('body.token', _.isString)
            const live = await getTokenLiveStatus(request.body.token);
            return {
                live
            }
        },

        '/points': async (request: Request) => {
            const authorization = resolveServiceAuthorization(request.headers.authorization as string | undefined);
            const tokens = tokenSplit(authorization);

            // 查询 jimeng 积分
            const points = await Promise.all(tokens.map(async (token) => {
                return {
                    token,
                    provider: 'jimeng',
                    points: await getCredit(token)
                }
            }));

            // 查询小云雀积分
            const xyqResults: any[] = [];
            try {
                const xyqAuth = String(process.env.XYQ_AUTHORIZATION || process.env.XYQ_SESSIONID || '').trim();
                if (xyqAuth) {
                    const xyqTokens = xyqTokenSplit(xyqAuth);
                    for (const token of xyqTokens) {
                        try {
                            const quota = await getXyqCredit(token);
                            xyqResults.push({
                                token,
                                provider: 'xyq',
                                quota
                            });
                        } catch (err: any) {
                            xyqResults.push({
                                token,
                                provider: 'xyq',
                                error: err.message
                            });
                        }
                    }
                }
            } catch (err: any) {
                logger.warn(`[XYQ] 积分查询失败: ${err.message}`);
            }

            return [...points, ...xyqResults];
        }

    }

}
