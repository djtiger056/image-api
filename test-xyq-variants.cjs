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

  // 导航并等待
  await page.goto('https://xyq.jianying.com/home?tab_name=home', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // 测试变体
  const variants = [
    {
      name: 'A: uid_from_cookie + 无run_extra',
      uid: 'c12ad1231b32ad9ee9bed35646008c66',
      runExtra: '{}',
    },
    {
      name: 'B: uid_from_api + 无run_extra',
      uid: '4320404315325544',
      runExtra: '{}',
    },
    {
      name: 'C: uid_from_api + 完整run_extra',
      uid: '4320404315325544',
      runExtra: JSON.stringify({ client_extra: { edit_type: 'montage_model', entrance_from: 'web', tab_name: 'other' } }),
    },
    {
      name: 'D: uid_from_cookie + 完整run_extra',
      uid: 'c12ad1231b32ad9ee9bed35646008c66',
      runExtra: JSON.stringify({ client_extra: { edit_type: 'montage_model', entrance_from: 'web', tab_name: 'other' } }),
    },
  ];

  for (const v of variants) {
    const result = await page.evaluate(async ({ uid, runExtra }) => {
      const body = {
        message: {
          message_id: '', role: 'user',
          thread_id: 'v-' + Date.now(), run_id: 'v-' + Date.now(),
          created_at: Date.now(),
          content: [{ type: 'text', sub_type: 'text', data: '一只猫' }]
        },
        user_info: { consumer_uid: uid, workspace_id: uid, app_id: '795647' },
        agent_name: 'pippit_image_agent_v2',
        entrance_from: 'web',
        run_extra: runExtra,
      };
      try {
        const resp = await fetch('/api/biz/v1/agent/submit_run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await resp.json();
      } catch (err) { return { error: err.message }; }
    }, { uid: v.uid, runExtra: v.runExtra });
    
    console.log(`${v.name}: ret=${result?.ret} errmsg=${result?.errmsg || 'ok'}`);
    if (result?.ret === '0' || result?.ret === 0) {
      console.log('  ✅ 成功!', JSON.stringify(result?.data));
    }
  }

  await browser.close();
})();
