const { chromium } = require('playwright-core');

const FULL_COOKIE = 'gfkadpd=795647,44487; s_v_web_id=verify_mp3vzxzi_maEUn8Kk_IUuJ_4naa_AkfK_APdyxwDcZ6hj; passport_csrf_token=b8c7957ae5b16064581a962c2d83c9dc; passport_csrf_token_default=b8c7957ae5b16064581a962c2d83c9dc; n_mh_pippitcn_web=TYi6FVGFmmr2oMW0MwOtDp2SKhHoKPmzsQELIVNMXfY; passport_auth_status_pippitcn_web=98f0690fb957697190f7bbbe6393003d%2C; passport_auth_status_ss_pippitcn_web=98f0690fb957697190f7bbbe6393003d%2C; sid_guard_pippitcn_web=acf331e56ac95cf8f5724004339910e7%7C1778666345%7C5184000%7CSun%2C+12-Jul-2026+09%3A59%3A05+GMT; uid_tt_pippitcn_web=c12ad1231b32ad9ee9bed35646008c66; uid_tt_ss_pippitcn_web=c12ad1231b32ad9ee9bed35646008c66; sid_tt_pippitcn_web=acf331e56ac95cf8f5724004339910e7; sessionid_pippitcn_web=acf331e56ac95cf8f5724004339910e7; sessionid_ss_pippitcn_web=acf331e56ac95cf8f5724004339910e7; session_tlb_tag_pippitcn_web=sttt%7C1%7CrPMx5WrJXPj1ckAEM5kQ5__________2qHmikXzbSmGz1aOnR5h3IiDJ5yTrbnMQCSL3x_u7QdY%3D; is_staff_user_pippitcn_web=false; has_biz_token_pippitcn_web=false; sid_ucp_v1_pippitcn_web=1.0.0-KDA2YmY2MDI1NWZiYWE5MDA3NWM4MWRjMDczY2FjZWI3YjczMTZiYjkKGAjoiIGkqKzWBxDplpHQBhj_xzA4AkDxBxoCaGwiIGFjZjMzMWU1NmFjOTVjZjhmNTcyNDAwNDMzOTkxMGU3; ssid_ucp_v1_pippitcn_web=1.0.0-KDA2YmY2MDI1NWZiYWE5MDA3NWM4MWRjMDczY2FjZWI3YjczMTZiYjkKGAjoiIGkqKzWBxDplpHQBhj_xzA4AkDxBxoCaGwiIGFjZjMzMWU1NmFjOTVjZjhmNTcyNDAwNDMzOTkxMGU3; biz_trace_id=7f6af8e5';

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  });
  const cookies = FULL_COOKIE.split('; ').map(pair => {
    const eqIdx = pair.indexOf('=');
    return { name: pair.substring(0, eqIdx), value: decodeURIComponent(pair.substring(eqIdx + 1)), domain: '.xyq.jianying.com', path: '/' };
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  // 监听submit_run响应
  page.on('response', async resp => {
    if (resp.url().includes('submit_run') || resp.url().includes('get_thread')) {
      try { console.log(`[响应] ${resp.url().split('?')[0]}:`, JSON.stringify(await resp.json()).substring(0, 500)); } catch {}
    }
  });

  // 导航
  await page.goto('https://xyq.jianying.com/home?tab_name=home', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // 先获取workspace_id
  console.log('[1] 获取workspace_id...');
  const workspaceResult = await page.evaluate(async () => {
    try {
      const resp = await fetch('/api/web/v1/workspace/get_user_workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return await resp.json();
    } catch (err) { return { error: err.message }; }
  });
  console.log('workspace:', JSON.stringify(workspaceResult));
  const workspaceId = workspaceResult?.data?.workspace_id || workspaceResult?.data?.id || '7633050188743431486';
  console.log('  workspace_id:', workspaceId);

  // 用正确的格式发送submit_run
  console.log('\n[2] 用正确格式发送submit_run...');
  const result = await page.evaluate(async ({ workspaceId }) => {
    const body = {
      message: {
        message_id: '',
        role: 'user',
        thread_id: crypto.randomUUID(),
        run_id: crypto.randomUUID(),
        created_at: Date.now(),
        content: [{
          type: 'data',
          sub_type: 'biz/x_data_prompt_text',
          data: JSON.stringify({ content: '一只可爱的猫咪' }),
        }],
      },
      user_info: {
        consumer_uid: '4320404315325544',
        workspace_id: workspaceId,
        app_id: '795647',
      },
      agent_name: 'pippit_nest_agent',
      entrance_from: 'web',
      run_extra: JSON.stringify({
        client_extra: {
          edit_type: 'integrated_agent',
          position: 'home',
          entrance_from: 'home',
          tab_name: 'other',
        },
      }),
    };

    try {
      const resp = await fetch('/api/biz/v1/agent/submit_run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await resp.json();
    } catch (err) { return { error: err.message }; }
  }, { workspaceId });

  console.log('submit_run结果:', JSON.stringify(result, null, 2));

  if (result?.ret === '0') {
    const threadId = result?.data?.run?.thread_id;
    const runId = result?.data?.run?.run_id;
    console.log(`\n[3] 成功! thread_id=${threadId}, 开始轮询...`);
    
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const poll = await page.evaluate(async ({ threadId, runId }) => {
        try {
          const resp = await fetch('/api/biz/v1/agent/get_thread', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              thread_id: threadId,
              run_id: runId,
              scopes: ['run_list.entry_list.limit(100).offset(0)'],
              limit: 100,
              is_need_fail_reason_detail: true,
            }),
          });
          return await resp.json();
        } catch (err) { return { error: err.message }; }
      }, { threadId, runId });

      const state = poll?.data?.thread?.run_list?.[0]?.state || poll?.data?.run?.state;
      console.log(`[轮询 ${i+1}] state=${state}`);
      
      if (state === 3) {
        console.log('✅ 完成!');
        // 提取图片URL
        const entries = poll?.data?.thread?.run_list?.[0]?.entry_list || [];
        for (const entry of entries) {
          const contents = entry?.message?.content || entry?.artifact?.content || [];
          for (const c of contents) {
            if (c?.type === 'image_url') console.log('图片:', c?.image_url?.url);
            if (c?.type === 'data' && c?.sub_type?.includes('image')) {
              try { const d = JSON.parse(c.data); console.log('图片:', d?.image?.url || d?.url); } catch {}
            }
          }
        }
        break;
      }
      if (state === 4 || state === 5) {
        console.log('❌ 失败:', poll?.data?.thread?.run_list?.[0]?.fail_reason);
        break;
      }
    }
  }

  await browser.close();
  console.log('\n[完成]');
})();
