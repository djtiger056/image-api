const { chromium } = require('playwright-core');

const FULL_COOKIE = 'gfkadpd=795647,44487; s_v_web_id=verify_mp3vzxzi_maEUn8Kk_IUuJ_4naa_AkfK_APdyxwDcZ6hj; passport_csrf_token=b8c7957ae5b16064581a962c2d83c9dc; passport_csrf_token_default=b8c7957ae5b16064581a962c2d83c9dc; n_mh_pippitcn_web=TYi6FVGFmmr2oMW0MwOtDp2SKhHoKPmzsQELIVNMXfY; passport_auth_status_pippitcn_web=98f0690fb957697190f7bbbe6393003d%2C; passport_auth_status_ss_pippitcn_web=98f0690fb957697190f7bbbe6393003d%2C; sid_guard_pippitcn_web=acf331e56ac95cf8f5724004339910e7%7C1778666345%7C5184000%7CSun%2C+12-Jul-2026+09%3A59%3A05+GMT; uid_tt_pippitcn_web=c12ad1231b32ad9ee9bed35646008c66; uid_tt_ss_pippitcn_web=c12ad1231b32ad9ee9bed35646008c66; sid_tt_pippitcn_web=acf331e56ac95cf8f5724004339910e7; sessionid_pippitcn_web=acf331e56ac95cf8f5724004339910e7; sessionid_ss_pippitcn_web=acf331e56ac95cf8f5724004339910e7; session_tlb_tag_pippitcn_web=sttt%7C1%7CrPMx5WrJXPj1ckAEM5kQ5__________2qHmikXzbSmGz1aOnR5h3IiDJ5yTrbnMQCSL3x_u7QdY%3D; is_staff_user_pippitcn_web=false; has_biz_token_pippitcn_web=false; sid_ucp_v1_pippitcn_web=1.0.0-KDA2YmY2MDI1NWZiYWE5MDA3NWM4MWRjMDczY2FjZWI3YjczMTZiYjkKGAjoiIGkqKzWBxDplpHQBhj_xzA4AkDxBxoCaGwiIGFjZjMzMWU1NmFjOTVjZjhmNTcyNDAwNDMzOTkxMGU3; ssid_ucp_v1_pippitcn_web=1.0.0-KDA2YmY2MDI1NWZiYWE5MDA3NWM4MWRjMDczY2FjZWI3YjczMTZiYjkKGAjoiIGkqKzWBxDplpHQBhj_xzA4AkDxBxoCaGwiIGFjZjMzMWU1NmFjOTVjZjhmNTcyNDAwNDMzOTkxMGU3; biz_trace_id=7f6af8e5';

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });
  const cookies = FULL_COOKIE.split('; ').map(pair => {
    const eqIdx = pair.indexOf('=');
    return { name: pair.substring(0, eqIdx), value: decodeURIComponent(pair.substring(eqIdx + 1)), domain: '.xyq.jianying.com', path: '/' };
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  // 关键：拦截submit_run请求，记录完整信息
  const capturedSubmitRuns = [];
  page.on('request', req => {
    if (req.url().includes('submit_run')) {
      capturedSubmitRuns.push({
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        postData: req.postData(),
      });
      console.log('\n🔥 捕获到submit_run请求!');
      console.log('URL:', req.url().substring(0, 200));
      console.log('Headers:', JSON.stringify(req.headers(), null, 2));
      console.log('Body:', req.postData()?.substring(0, 1000));
    }
  });
  page.on('response', async resp => {
    if (resp.url().includes('submit_run')) {
      try { console.log('\n📨 submit_run响应:', JSON.stringify(await resp.json())); } catch {}
    }
  });

  console.log('[1] 导航...');
  await page.goto('https://xyq.jianying.com/home?tab_name=home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);

  // 关闭弹窗
  console.log('[2] 关闭弹窗...');
  const closeButtons = await page.$$('.lv-modal-wrapper .lv-modal-close, .lv-modal-wrapper [class*="close"], .lv-modal-wrapper button');
  for (const btn of closeButtons) {
    try { await btn.click({ timeout: 2000 }); console.log('  关闭了一个弹窗'); break; } catch {}
  }
  // 也试试按ESC
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);

  // 截图看状态
  await page.screenshot({ path: '/myproject/images-api/xyq-after-close.png' });

  // 找到"新对话"按钮并点击
  console.log('[3] 点击新对话...');
  const newChatBtn = await page.$('text=新对话');
  if (newChatBtn) {
    try { await newChatBtn.click({ timeout: 3000 }); console.log('  已点击'); } catch (e) { console.log('  点击失败:', e.message); }
    await page.waitForTimeout(3000);
  }

  // 找输入框
  console.log('[4] 找输入框...');
  const textarea = await page.$('textarea, [contenteditable="true"]');
  if (textarea) {
    console.log('  找到输入框');
    await textarea.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    await textarea.type('一只可爱的猫咪', { delay: 30 });
    await page.waitForTimeout(1000);

    // 找发送/生成按钮
    console.log('[5] 找发送按钮...');
    const sendBtns = await page.$$('[aria-label="submit"], [aria-label="send"], [class*="submit"], [class*="send-btn"]');
    console.log('  找到', sendBtns.length, '个按钮');
    
    // 也试试按Enter
    console.log('  按Enter提交...');
    await page.keyboard.press('Enter');
    
    // 等待响应
    console.log('[6] 等待响应...');
    await page.waitForTimeout(20000);

    // 显示捕获的请求
    console.log('\n[7] 捕获到的submit_run请求数:', capturedSubmitRuns.length);
    if (capturedSubmitRuns.length > 0) {
      const req = capturedSubmitRuns[0];
      console.log('\n=== 真实submit_run请求 ===');
      console.log('URL:', req.url);
      console.log('Body:', req.postData);
    }
  } else {
    console.log('  没找到输入框');
    // 列出所有可交互元素
    const allInputs = await page.$$('input, textarea, [contenteditable]');
    console.log('  所有input类元素:', allInputs.length);
  }

  await browser.close();
  console.log('\n[完成]');
})();
