const { chromium } = require('playwright-core');
const FULL_COOKIE = 'gfkadpd=795647,44487; s_v_web_id=verify_mp3vzxzi_maEUn8Kk_IUuJ_4naa_AkfK_APdyxwDcZ6hj; passport_csrf_token=b8c7957ae5b16064581a962c2d83c9dc; passport_csrf_token_default=b8c7957ae5b16064581a962c2d83c9dc; n_mh_pippitcn_web=TYi6FVGFmmr2oMW0MwOtDp2SKhHoKPmzsQELIVNMXfY; passport_auth_status_pippitcn_web=98f0690fb957697190f7bbbe6393003d%2C; passport_auth_status_ss_pippitcn_web=98f0690fb957697190f7bbbe6393003d%2C; sid_guard_pippitcn_web=acf331e56ac95cf8f5724004339910e7%7C1778666345%7C5184000%7CSun%2C+12-Jul-2026+09%3A59%3A05+GMT; uid_tt_pippitcn_web=c12ad1231b32ad9ee9bed35646008c66; uid_tt_ss_pippitcn_web=c12ad1231b32ad9ee9bed35646008c66; sid_tt_pippitcn_web=acf331e56ac95cf8f5724004339910e7; sessionid_pippitcn_web=acf331e56ac95cf8f5724004339910e7; sessionid_ss_pippitcn_web=acf331e56ac95cf8f5724004339910e7; session_tlb_tag_pippitcn_web=sttt%7C1%7CrPMx5WrJXPj1ckAEM5kQ5__________2qHmikXzbSmGz1aOnR5h3IiDJ5yTrbnMQCSL3x_u7QdY%3D; is_staff_user_pippitcn_web=false; has_biz_token_pippitcn_web=false; sid_ucp_v1_pippitcn_web=1.0.0-KDA2YmY2MDI1NWZiYWE5MDA3NWM4MWRjMDczY2FjZWI3YjczMTZiYjkKGAjoiIGkqKzWBxDplpHQBhj_xzA4AkDxBxoCaGwiIGFjZjMzMWU1NmFjOTVjZjhmNTcyNDAwNDMzOTkxMGU3; ssid_ucp_v1_pippitcn_web=1.0.0-KDA2YmY2MDI1NWZiYWE5MDA3NWM4MWRjMDczY2FjZWI3YjczMTZiYjkKGAjoiIGkqKzWBxDplpHQBhj_xzA4AkDxBxoCaGwiIGFjZjMzMWU1NmFjOTVjZjhmNTcyNDAwNDMzOTkxMGU3; biz_trace_id=7f6af8e5';

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36' });
  await context.addCookies(FULL_COOKIE.split('; ').map(p => { const i = p.indexOf('='); return { name: p.substring(0,i), value: decodeURIComponent(p.substring(i+1)), domain: '.xyq.jianying.com', path: '/' }; }));
  const page = await context.newPage();
  page.on('response', async r => { if (r.url().includes('submit_run')||r.url().includes('get_thread')) try { console.log(`[${r.url().split('?')[0].split('/').pop()}]`, JSON.stringify(await r.json()).substring(0,600)); } catch {} });

  await page.goto('https://xyq.jianying.com/home?tab_name=home', { waitUntil: 'networkidle', timeout: 60000 }).catch(()=>{});
  await page.waitForTimeout(5000);

  // 获取workspace_id
  const ws = await page.evaluate(async () => { try { return (await (await fetch('/api/web/v1/workspace/get_user_workspace', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })).json()); } catch(e){return{error:e.message}} });
  const wsId = ws?.data?.workspace_id || '7633050188743431486';
  console.log('workspace_id:', wsId);

  // 测试所有agent_name + 正确content格式
  const agents = ['pippit_image_agent_v2', 'pippit_nest_agent'];
  for (const agent of agents) {
    console.log(`\n=== 测试 agent: ${agent} ===`);
    const result = await page.evaluate(async ({ wsId, agent }) => {
      const body = {
        message: { message_id:'', role:'user', thread_id:crypto.randomUUID(), run_id:crypto.randomUUID(), created_at:Date.now(),
          content: [{ type:'data', sub_type:'biz/x_data_prompt_text', data: JSON.stringify({content:'一只可爱的猫'}) }]
        },
        user_info: { consumer_uid:'4320404315325544', workspace_id:wsId, app_id:'795647' },
        agent_name: agent, entrance_from: 'web',
        run_extra: JSON.stringify({ client_extra:{ edit_type:'integrated_agent', position:'home', entrance_from:'home', tab_name:'other' } }),
      };
      try { return await (await fetch('/api/biz/v1/agent/submit_run', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })).json(); } catch(e){return{error:e.message}}
    }, { wsId, agent });
    console.log(`ret=${result?.ret}, run_id=${result?.data?.run?.run_id || 'none'}, thread_id=${result?.data?.run?.thread_id || 'none'}`);
  }

  await browser.close();
})();
