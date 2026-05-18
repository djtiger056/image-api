import fs from 'fs-extra';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import { getConsoleStatus, saveConsoleCredentials } from '@/lib/console-service.ts';

export default {
  get: {
    '/console': async () => {
      const content = await fs.readFile('public/console.html');
      return new Response(content, {
        type: 'html',
        headers: {
          Expires: '-1',
        },
      });
    },
    '/docs/api-guide': async () => {
      const content = await fs.readFile('public/api-guide.html');
      return new Response(content, {
        type: 'html',
        headers: {
          Expires: '-1',
        },
      });
    },
    '/console/status': async (request: Request) => {
      const deep = ['1', 'true', 'yes'].includes(String(request.query.deep || '').toLowerCase());
      return getConsoleStatus({ deep });
    },
  },
  post: {
    '/console/credentials': async (request: Request) => {
      return saveConsoleCredentials(request.body || {});
    },
  },
};
