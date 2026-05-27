import fs from 'fs-extra';

import Response from '@/lib/response/Response.ts';
import images from "./images.ts";
import chat from "./chat.ts";
import ping from "./ping.ts";
import token from './token.js';
import models from './models.ts';
import videos from './videos.ts';
import video from './video.ts';
import consoleRoutes from './console.ts';
import seedream from './seedream.ts';
import doubaoVideo from './doubao-video.ts';
import qwenVideo from './qwen-video.ts';
import xyqVideo from './xyq-video.ts';

export default [
    {
        get: {
            '/': async () => {
                const content = await fs.readFile('public/welcome.html');
                return new Response(content, {
                    type: 'html',
                    headers: {
                        Expires: '-1'
                    }
                });
            }
        }
    },
    images,
    chat,
    ping,
    token,
    models,
    videos,
    video,
    consoleRoutes,
    seedream
    ,doubaoVideo
    ,qwenVideo
    ,xyqVideo
];
