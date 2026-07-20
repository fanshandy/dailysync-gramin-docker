import express from 'express';
import mysql from 'mysql2/promise';
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = 9610;
const INVITE_CODE = '92960910';
const ENC_KEY = process.env.ENC_KEY || 'dailysync-secret-key-2024';

// DB config
const DB_HOST = process.env.DB_HOST || 'mariadb';
const DB_PORT = parseInt(process.env.DB_PORT || '3306');
const DB_USER = process.env.DB_USER || 'dailysync';
const DB_PASS = process.env.DB_PASS || 'changeme';
const DB_NAME = process.env.DB_NAME || 'dailysync';

// Encrypt/decrypt helpers
function encrypt(text: string): string {
  const cipher = crypto.createCipheriv('aes-256-cbc', crypto.createHash('sha256').update(ENC_KEY).digest(), Buffer.from(ENC_KEY.slice(0, 16)));
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
}

function decrypt(enc: string): string {
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', crypto.createHash('sha256').update(ENC_KEY).digest(), Buffer.from(ENC_KEY.slice(0, 16)));
    let dec = decipher.update(enc, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch {
    return '';
  }
}

let db: mysql.Pool;
async function initDb() {
  db = mysql.createPool({
    waitForConnections: true,
    connectionLimit: 5,
    enableKeepAlive: true,
    keepAliveInitialDelay: 60000,
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
  });

  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(128) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS garmin_config (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    cn_user VARCHAR(255) DEFAULT '',
    cn_pass_enc VARCHAR(255) DEFAULT '',
    global_user VARCHAR(255) DEFAULT '',
    global_pass_enc VARCHAR(255) DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS sync_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL,
    sync_time VARCHAR(50) NOT NULL,
    success TINYINT(1) DEFAULT 0,
    message TEXT,
    duration INT DEFAULT 0,
    cn_count INT DEFAULT 0,
    global_count INT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
}

function hashPassword(pw: string): string {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

// Sync for a specific user
async function syncForUser(username: string): Promise<{ success: boolean; message: string; cnCount: number; globalCount: number }> {
  const [rows] = await db.execute('SELECT * FROM garmin_config WHERE username = ?', [username]);
  const config = (rows as any[])[0];
  if (!config || !config.cn_user || !config.global_user) {
    return { success: false, message: '未配置佳明账号', cnCount: 0, globalCount: 0 };
  }

  const cnPwd = decrypt(config.cn_pass_enc);
  const globalPwd = decrypt(config.global_pass_enc);
  if (!cnPwd || !globalPwd) {
    return { success: false, message: '佳明密码解密失败，请重新保存配置', cnCount: 0, globalCount: 0 };
  }

  // Write .env file for this sync
  const envContent = [
    `GARMIN_USERNAME_DEFAULT=${config.cn_user}`,
    `GARMIN_PASSWORD_DEFAULT=${cnPwd}`,
    `GARMIN_GLOBAL_USERNAME_DEFAULT=${config.global_user}`,
    `GARMIN_GLOBAL_PASSWORD_DEFAULT=${globalPwd}`,
    `GARMIN_SYNC_NUM_DEFAULT=10`,
  ].join('\n');

  const envPath = '/app/.env.sync';
  await fs.writeFile(envPath, envContent);

  return new Promise((resolve) => {
    const startTime = Date.now();
    const child = spawn('yarn', ['sync_cn'], {
      cwd: '/app',
      env: { ...process.env, GARMIN_USERNAME_DEFAULT: config.cn_user, GARMIN_PASSWORD_DEFAULT: cnPwd, GARMIN_GLOBAL_USERNAME_DEFAULT: config.global_user, GARMIN_GLOBAL_PASSWORD_DEFAULT: globalPwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });

    child.on('close', async (code) => {
      const duration = Date.now() - startTime;
      const success = code === 0;
      let message = success ? '同步完成' : '同步失败';
      if (output.includes('No new activities') || output.includes('没有要同步的活动内容')) message = '同步完成（无新活动）';
      if (output.includes('login failed') || output.includes('Ticket not found')) message = '同步失败：佳明登录验证失败，请检查账号密码';

      // Try to extract counts
      let cnCount = 0, globalCount = 0;
      const cnMatch = null; // fixed
      const globalMatch = null; // fixed
      if (cnMatch) cnCount = parseInt(cnMatch[1]);
      const actMatch = output.match(/上传第 (\d+) 条/);
      if (actMatch) cnCount = parseInt(actMatch[1]);
      if (globalMatch) globalCount = parseInt(globalMatch[1]);

      // Save history
      const now = new Date();
      const syncTime = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      const msg = message + (output.length > 500 ? '\n' + output.slice(0, 500) : '\n' + output);

      try {
        await db.execute(
          'INSERT INTO sync_history (username, sync_time, success, message, duration, cn_count, global_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [username, syncTime, success ? 1 : 0, msg, duration, cnCount, globalCount]
        );
      } catch (e) {
        console.error('Failed to save sync history:', e);
      }

      resolve({ success, message, cnCount, globalCount });
    });

    child.on('error', async (err) => {
      const duration = Date.now() - startTime;
      await db.execute(
        'INSERT INTO sync_history (username, sync_time, success, message, duration, cn_count, global_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [username, new Date().toISOString(), 0, `进程启动失败: ${err.message}`, duration, 0, 0]
      );
      resolve({ success: false, message: `进程启动失败: ${err.message}`, cnCount: 0, globalCount: 0 });
    });
  });
}

// Scheduled sync for all users
let syncInProgress = false;
async function scheduledSync() {
  if (syncInProgress) {
    console.log('Sync already in progress, skipping scheduled sync');
    return;
  }
  syncInProgress = true;
  console.log('Starting scheduled sync for all users...');

  try {
    const [rows] = await db.execute('SELECT username FROM garmin_config WHERE cn_user != "" AND global_user != ""');
    const users = rows as any[];
    console.log(`Found ${users.length} users with garmin config`);

    for (const user of users) {
      console.log(`Syncing for user: ${user.username}`);
      const result = await syncForUser(user.username);
      console.log(`Sync result for ${user.username}: ${result.success ? 'OK' : 'FAIL'} - ${result.message}`);
    }
  } catch (e) {
    console.error('Scheduled sync error:', e);
  }

  syncInProgress = false;
  console.log('Scheduled sync completed');
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth middleware
function auth(req: any, res: any, next: any) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: '未登录' }); return; }
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    const [username, ts] = decoded.split(':');
    if (Date.now() - parseInt(ts) > 86400000) { res.status(401).json({ error: '登录已过期' }); return; }
    req.username = username;
    next();
  } catch {
    res.status(401).json({ error: '无效的令牌' });
    return;
  }
}

// Static files
app.get('/', (req, res) => res.redirect('/login.html'));
app.get('/login.html', (req, res) => res.send(LOGIN_HTML));
app.get('/dashboard.html', (req, res) => res.send(DASHBOARD_HTML));
app.use('/assets', express.static('/app/assets'));

// API: Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

  try {
    const [rows] = await db.execute('SELECT * FROM users WHERE username = ? AND password_hash = ?', [username, hashPassword(password)]);
    const users = rows as any[];
    if (users.length === 0) return res.status(401).json({ error: '用户名或密码错误' });

    const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
    res.json({ token, username });
  } catch (e) {
    console.error('Login error:', e); res.status(500).json({ error: '登录失败' });
  }
});

// API: Register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写所有字段' });
  if (username.length < 2 || password.length < 4) return res.status(400).json({ error: '用户名至少2位，密码至少4位' });

  try {
    await db.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hashPassword(password)]);
    res.json({ success: true, message: '注册成功' });
  } catch (e: any) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '用户名已存在' });
    res.status(500).json({ error: '注册失败' });
  }
});

// API: Get config
app.get('/api/config', auth, async (req, res) => {
  const username = (req as any).username;
  const [rows] = await db.execute('SELECT * FROM garmin_config WHERE username = ?', [username]);
  const config = (rows as any[])[0];
  if (!config) return res.json({ cn_account: '', global_account: '' });
  res.json({
    cn_account: config.cn_user,
    global_account: config.global_user,
  });
});

// API: Save config
app.post('/api/config', auth, async (req, res) => {
  const username = (req as any).username;
  const { cn_user, cn_password, global_user, global_password } = req.body;

  if (!cn_user || !cn_password || !global_user || !global_password) {
    return res.status(400).json({ error: '请填写所有佳明账号和密码' });
  }

  const cnPwdEnc = encrypt(cn_password);
  const globalPwdEnc = encrypt(global_password);

  await db.execute(
    `INSERT INTO garmin_config (username, cn_user, cn_pass_enc, global_user, global_pass_enc)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cn_user=VALUES(cn_user), cn_pass_enc=VALUES(cn_pass_enc),
       global_user=VALUES(global_user), global_pass_enc=VALUES(global_pass_enc)`,
    [username, cn_user, cnPwdEnc, global_user, globalPwdEnc]
  );

  res.json({ success: true, message: '配置已保存' });
});

// API: Manual sync
app.post('/api/sync', auth, async (req, res) => {
  const username = (req as any).username;
  if (syncInProgress) return res.status(429).json({ error: '同步正在进行中，请稍后再试' });

  syncInProgress = true;
  try {
    const result = await syncForUser(username);
    res.json(result);
  } finally {
    syncInProgress = false;
  }
});

// API: Sync status/history
app.get('/api/status', auth, async (req, res) => {
  const username = (req as any).username;
  const [rows] = await db.execute(
    'SELECT * FROM sync_history WHERE username = ? ORDER BY id DESC LIMIT 10',
    [username]
  );
  const [configRows] = await db.execute('SELECT * FROM garmin_config WHERE username = ?', [username]);
  const config = (configRows as any[])[0];

  // Add cumulative counts from latest successful sync
  let totalCn = 0, totalGlobal = 0;
  const [successRows] = await db.execute(
    "SELECT cn_count, global_count FROM sync_history WHERE username = ? AND success = 1 AND cn_count > 0 ORDER BY id DESC LIMIT 1",
    [username]
  );
  if ((successRows as any[]).length > 0) {
    totalCn = (successRows as any[])[0].cn_count || 0;
    totalGlobal = (successRows as any[])[0].global_count || 0;
  }

  res.json({
    history: rows,
    hasConfig: !!config && !!config.cn_user,
    cnAccount: config?.cn_user || '',
    globalAccount: config?.global_user || '',
    totalCnCount: totalCn,
    totalGlobalCount: totalGlobal,
  });
});

// Start server
async function start() {
  await initDb();
  console.log('Database initialized');

  // Schedule sync at 08:00 and 16:00 Asia/Shanghai
  cron.schedule('0 8,16 * * *', () => {
    scheduledSync().catch(e => console.error('Scheduled sync error:', e));
  }, { timezone: 'Asia/Shanghai' });
  console.log('Scheduled sync: 08:00 and 16:00 Asia/Shanghai');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[WebUI] http://0.0.0.0:${PORT}`);
    console.log(`Invite code: ${INVITE_CODE}`);
  });
}

start().catch(e => {
  console.error('Failed to start:', e);
  process.exit(1);
});

// ============ HTML ============

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>佳明运动数据同步</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460)}
.card{background:rgba(255,255,255,0.95);border-radius:16px;padding:40px;width:380px;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
.card h2{text-align:center;margin-bottom:8px;color:#1a1a2e;font-size:24px}
.card p.subtitle{text-align:center;color:#666;margin-bottom:30px;font-size:14px}
.form-group{margin-bottom:18px}
.form-group label{display:block;margin-bottom:6px;color:#333;font-size:14px;font-weight:500}
.form-group input{width:100%;padding:12px 14px;border:2px solid #e0e0e0;border-radius:8px;font-size:15px;transition:border-color .2s}
.form-group input:focus{outline:none;border-color:#0f3460}
.btn{width:100%;padding:12px;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-primary{background:#0f3460;color:#fff}
.btn-primary:hover{opacity:0.9}
.btn-success{background:#27ae60;color:#fff}
.btn-link{background:transparent;color:#0f3460;padding:8px;font-size:14px;margin-top:8px}
.btn-link:hover{text-decoration:underline}
.error{color:#e74c3c;font-size:13px;margin-top:6px;display:none}
.success{color:#27ae60;font-size:13px;margin-top:6px;display:none}
.tabs{display:flex;margin-bottom:25px;border-bottom:2px solid #e0e0e0}
.tab{flex:1;text-align:center;padding:10px;cursor:pointer;color:#666;font-weight:500;transition:all .2s}
.tab.active{color:#0f3460;border-bottom:2px solid #0f3460;margin-bottom:-2px}
.tab-content{display:none}
.tab-content.active{display:block}
.toast{position:fixed;top:20px;right:20px;padding:14px 24px;border-radius:8px;color:#fff;font-size:14px;z-index:9999;transform:translateX(120%);transition:transform .4s;max-width:320px}
.toast.show{transform:translateX(0)}
.toast.error{background:#e74c3c}
.toast.success{background:#27ae60}
</style>
</head>
<body>
<div id="toast" class="toast"></div>
<div class="card">
  <h2>🏃 佳明数据同步</h2>
  <p class="subtitle">Garmin CN ↔ Global</p>
  <div class="tabs">
    <div class="tab active" onclick="switchTab('login')">登录</div>
    <div class="tab" onclick="switchTab('register')">注册</div>
  </div>

  <div id="login-tab" class="tab-content active">
    <div class="form-group"><label>用户名</label><input id="login-user" type="text" placeholder="请输入用户名"></div>
    <div class="form-group"><label>密码</label><input id="login-pass" type="password" placeholder="请输入密码"></div>
    <div id="login-error" class="error"></div>
    <button class="btn btn-primary" onclick="doLogin()">登 录</button>
  </div>

  <div id="register-tab" class="tab-content">
    <div class="form-group"><label>用户名</label><input id="reg-user" type="text" placeholder="至少2个字符"></div>
    <div class="form-group"><label>密码</label><input id="reg-pass" type="password" placeholder="至少4个字符"></div>
    <div id="reg-error" class="error"></div>
    <button class="btn btn-success" onclick="doRegister()">注 册</button>
  </div>
</div>
<script>
function showToast(msg,type){var t=document.getElementById('toast');t.textContent=msg;t.className='toast '+type+' show';setTimeout(function(){t.className='toast'},3000)}
function switchTab(t){document.querySelectorAll('.tab').forEach(function(e){e.classList.remove('active')});document.querySelectorAll('.tab-content').forEach(function(e){e.classList.remove('active')});if(t==='login'){document.querySelectorAll('.tab')[0].classList.add('active');document.getElementById('login-tab').classList.add('active')}else{document.querySelectorAll('.tab')[1].classList.add('active');document.getElementById('register-tab').classList.add('active')}}
function doLogin(){var u=document.getElementById('login-user').value.trim(),p=document.getElementById('login-pass').value.trim(),e=document.getElementById('login-error');if(!u||!p){e.textContent='请填写完整';e.style.display='block';return}e.style.display='none';fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})}).then(function(r){return r.json()}).then(function(d){if(d.error){e.textContent=d.error;e.style.display='block'}else{localStorage.setItem('token',d.token);localStorage.setItem('username',d.username);window.location.href='/dashboard.html'}}).catch(function(){e.textContent='网络错误';e.style.display='block'})}
function doRegister(){var u=document.getElementById('reg-user').value.trim(),p=document.getElementById('reg-pass').value.trim(),e=document.getElementById('reg-error');if(!u||!p){e.textContent='请填写所有字段';e.style.display='block';return}e.style.display='none';fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})}).then(function(r){return r.json()}).then(function(d){if(d.error){e.textContent=d.error;e.style.display='block'}else{showToast('注册成功，请登录','success');switchTab('login')}}).catch(function(){e.textContent='网络错误';e.style.display='block'})}
</script>
</body>
</html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>同步面板 - 佳明数据同步</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
body{background:#f0f2f5;min-height:100vh}
.header{background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);color:#fff;padding:20px 30px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:20px}
.header .user-info{display:flex;align-items:center;gap:15px}
.header .user-info span{opacity:0.8;font-size:14px}
.btn-logout{background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px}
.btn-logout:hover{background:rgba(255,255,255,0.25)}
.container{max-width:900px;margin:0 auto;padding:30px 20px}
.card{background:#fff;border-radius:12px;padding:24px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.06)}
.card h3{font-size:16px;color:#333;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.form-row{display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.form-row .field{flex:1;min-width:180px}
.form-row label{display:block;font-size:13px;color:#666;margin-bottom:4px;font-weight:500}
.form-row input{width:100%;padding:10px 12px;border:2px solid #e0e0e0;border-radius:8px;font-size:14px;transition:border-color .2s}
.form-row input:focus{outline:none;border-color:#0f3460}
.btn{padding:10px 24px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s}
.btn-primary{background:#0f3460;color:#fff}
.btn-primary:hover{opacity:0.9}
.btn-primary:disabled{background:#999;cursor:not-allowed}
.btn-success{background:#27ae60;color:#fff}
.btn-success:hover{opacity:0.9}
.btn-danger{background:#e74c3c;color:#fff}
.status-bar{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.stat{padding:16px 20px;border-radius:10px;flex:1;min-width:120px;text-align:center}
.stat.cn{background:#e8f4fd;color:#0f3460}
.stat.global{background:#fef9e7;color:#7d6608}
.stat.sync{background:#e8f8f5;color:#1a7a5c}
.stat .num{font-size:22px;font-weight:700;display:block}
.stat .label{font-size:12px;opacity:0.8;margin-top:4px}
.hist-item{padding:10px 14px;border-left:3px solid #27ae60;margin-bottom:8px;background:#fafafa;border-radius:4px;font-size:13px}
.hist-item.fail{border-left-color:#e74c3c}
.hist-item .time{color:#999;font-size:12px}
.hist-item .msg{color:#333;margin-top:4px}
.hist-item .detail{color:#888;font-size:12px;margin-top:2px}
.alert{padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:14px}
.alert-info{background:#e8f4fd;color:#0f3460;border:1px solid #b8d4f0}
.alert-success{background:#d5f5e3;color:#1a7a5c;border:1px solid #a3d9b1}
.alert-danger{background:#fadbd8;color:#c0392b;border:1px solid #f5b7b1}
#toast{position:fixed;top:20px;right:20px;padding:14px 24px;border-radius:8px;color:#fff;font-size:14px;z-index:9999;transform:translateX(120%);transition:transform .4s;max-width:320px}
#toast.show{transform:translateX(0)}#toast.error{background:#e74c3c}#toast.success{background:#27ae60}
.loading{display:inline-block;width:16px;height:16px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div id="toast"></div>
<div class="header">
  <h1>🏃 佳明运动数据同步</h1>
  <div class="user-info">
    <span>👤 <span id="currentUser"></span></span>
    <button class="btn-logout" onclick="logout()">退出</button>
  </div>
</div>
<div class="container">
  <div id="noConfigAlert" class="alert alert-info" style="display:none">
    ⚠️ 您尚未配置佳明账号，请在下方填写并保存配置后开始同步。
  </div>

  <div class="card">
    <h3>📊 同步状态</h3>
    <div class="status-bar">
      <div class="stat cn"><span class="num" id="cnCount">0</span><span class="label">国区活动数</span></div>
      <div class="stat global"><span class="num" id="globalCount">0</span><span class="label">国际区活动数</span></div>
      <div class="stat sync"><span class="num" id="totalSyncs">0</span><span class="label">同步次数</span></div>
    </div>
    <button class="btn btn-success" id="syncBtn" onclick="doSync()">🔄 开始同步</button>
  </div>

  <div class="card">
    <h3>⚙️ 佳明账号配置</h3>
    <div class="form-row">
      <div class="field"><label>中国区账号 (connect.garmin.cn)</label><input id="cnAccount" placeholder="中国区邮箱"></div>
      <div class="field"><label>中国区密码</label><input id="cnPassword" type="password" placeholder="中国区密码"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>国际区账号 (connect.garmin.com)</label><input id="globalAccount" placeholder="国际区邮箱"></div>
      <div class="field"><label>国际区密码</label><input id="globalPassword" type="password" placeholder="国际区密码"></div>
    </div>
    <button class="btn btn-primary" onclick="saveConfig()">💾 保存配置</button>
    <span id="configMsg" style="font-size:13px;margin-left:12px;color:#27ae60;display:none"></span>
  </div>

  <div class="card">
    <h3>📋 同步记录</h3>
    <div id="historyList"></div>
  </div>
</div>
<script>
var token=localStorage.getItem('token'),username=localStorage.getItem('username');
if(!token||!username){window.location.href='/login.html'}
document.getElementById('currentUser').textContent=username;

function showToast(msg,type){var t=document.getElementById('toast');t.textContent=msg;t.className='toast '+type+' show';setTimeout(function(){t.className='toast'},3000)}

function logout(){localStorage.removeItem('token');localStorage.removeItem('username');window.location.href='/login.html'}

function api(path,method,body){var opts={method:method||'GET',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'}};if(body)opts.body=JSON.stringify(body);return fetch(path,opts).then(function(r){return r.json()})}

function loadStatus(){api('/api/status').then(function(d){if(d.error)return;var h=d.history||[];var successCount=h.filter(function(x){return x.success}).length;document.getElementById('totalSyncs').textContent=h.length;if(h.length>0){document.getElementById('cnCount').textContent=d.totalCnCount||0;document.getElementById('globalCount').textContent=d.totalGlobalCount||0}if(h.length===0){document.getElementById('cnCount').textContent='0';document.getElementById('globalCount').textContent='0'}
var noCfg=document.getElementById('noConfigAlert');if(!d.hasConfig){noCfg.style.display='block'}else{noCfg.style.display='none'}
if(d.cnAccount){document.getElementById('cnAccount').value=d.cnAccount}if(d.globalAccount){document.getElementById('globalAccount').value=d.globalAccount}
var list=document.getElementById('historyList');list.innerHTML='';if(h.length===0){list.innerHTML='<div style=\"color:#999;text-align:center;padding:20px\">暂无同步记录</div>';return}
h.forEach(function(item){var cls='hist-item'+(item.success?'':' fail');var t=item.sync_time||item.created_at;var dur=item.duration?(item.duration/1000).toFixed(1)+'s':'';var counts='';if(item.cn_count||item.global_count){counts='国区'+item.cn_count+' 国际区'+item.global_count}
list.innerHTML+='<div class=\"'+cls+'\"><div class=\"time\">'+t+' '+(dur?'('+dur+')':'')+'</div><div class=\"msg\">'+(item.success?'✅ ':'❌ ')+(item.message||'').split('\\n')[0]+'</div>'+(counts?'<div class=\"detail\">'+counts+'</div>':'')+'</div>'})})}

function saveConfig(){var data={cn_user:document.getElementById('cnAccount').value.trim(),cn_password:document.getElementById('cnPassword').value,global_user:document.getElementById('globalAccount').value.trim(),global_password:document.getElementById('globalPassword').value};var msg=document.getElementById('configMsg');if(!data.cn_user||!data.cn_password||!data.global_user||!data.global_password){showToast('请填写所有账号密码','error');return}
api('/api/config','POST',data).then(function(d){if(d.error){showToast(d.error,'error')}else{showToast('配置已保存','success');document.getElementById('cnPassword').value='';document.getElementById('globalPassword').value='';loadStatus()}})}

function doSync(){var btn=document.getElementById('syncBtn');btn.disabled=true;btn.innerHTML='<span class=\"loading\"></span> 同步中...';api('/api/sync','POST').then(function(d){if(d.error){showToast(d.error,'error')}else{showToast(d.message,'success')}loadStatus()}).catch(function(){showToast('同步请求失败','error')}).finally(function(){btn.disabled=false;btn.innerHTML='🔄 开始同步'})}

loadStatus();
</script>
</body>
</html>`;
