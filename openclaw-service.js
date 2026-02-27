const { spawn, exec } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env file
require('dotenv').config();

const CONFIG = {
  ssh: { 
    cmd: 'ssh', 
    args: ['-N', '-L', '18789:127.0.0.1:18789', '-i', process.env.SSH_KEY_PATH, process.env.SSH_HOST], 
    name: 'SSH Tunnel' 
  },
  node: { cmd: 'openclaw', args: ['node', 'run'], name: 'OpenCLAW Node' },
  browser: { cmd: 'openclaw', args: ['browser', 'start'], name: 'Browser Relay' },
  port: process.env.PORT || 18888,
  checkInterval: 5000
};

const processes = {};
const status = { ssh: { running: false, lastCheck: null, error: null, restarts: 0 }, node: { running: false, lastCheck: null, error: null, restarts: 0 }, browser: { running: false, lastCheck: null, error: null, restarts: 0 } };
let autoRestart = true;
let restartCount = {};

const LOG_FILE = path.join(__dirname, 'openclaw-service.log');

function log(level, msg, data = null) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}\n`;
  fs.appendFile(LOG_FILE, logLine, () => {});
  if (level === 'ERROR') console.error(logLine.trim()); else console.log(logLine.trim());
}

function notify(title, message) {
  const script = `Add-Type -AssemblyName System.Windows.Forms; $b = New-Object System.Windows.Forms.NotifyIcon; $b.Icon = [System.Drawing.SystemIcons]::Info; $b.BalloonTipTitle = "${title}"; $b.BalloonTipText = "${message.replace(/"/g, "'")}"; $b.Visible = $true; $b.ShowBalloonTip(5000); Start-Sleep 1; $b.Dispose()`;
  exec(`powershell -Command "${script}"`, () => {});
}

function killPort(port, callback) {
  exec(`netstat -ano | findstr :${port}`, (err, stdout) => {
    if (!stdout) { callback(); return; }
    const pids = new Set();
    stdout.trim().split('\n').forEach(line => { const parts = line.trim().split(/\s+/); if (parts.length >= 5 && parts[4] && !isNaN(parts[4])) pids.add(parts[4]); });
    if (pids.size === 0) { callback(); return; }
    let count = pids.size;
    pids.forEach(pid => { exec(`taskkill /F /PID ${pid}`, () => { if (--count === 0) setTimeout(callback, 1000); }); });
  });
}

function spawnProcess(key, config) {
  if (processes[key]) { log('WARN', `${config.name} already running`); return; }
  log('INFO', `Starting ${config.name}...`);
  restartCount[key] = (restartCount[key] || 0) + 1;
  const proc = spawn(config.cmd, config.args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let outputBuffer = '';
  proc.stdout.on('data', d => { const text = d.toString(); outputBuffer += text; log('DEBUG', `[${config.name}] ${text.trim().substring(0, 200)}`); });
  proc.stderr.on('data', d => { const text = d.toString(); if (!text.includes('WARNING')) { outputBuffer += text; log('DEBUG', `[${config.name}] ERR: ${text.trim().substring(0, 200)}`); } });
  
  proc.on('close', code => {
    log('INFO', `${config.name} exited with code ${code}`);
    processes[key] = null;
    status[key].running = false;
    status[key].lastCheck = new Date().toISOString();
    status[key].error = `Exit: ${code}`;
    
    if (key === 'browser') {
      const isNoTab = outputBuffer.includes('no tab is connected');
      const isGatewayClosed = outputBuffer.includes('gateway closed');
      if (isNoTab || isGatewayClosed) { 
        log('WARN', `${config.name} waiting for user to click extension... retrying every 3s`);
        // 持续重试，直到用户点击插件连接
        if (autoRestart) {
          setTimeout(() => spawnProcess(key, config), 3000);
        }
        return; 
      }
    }
    
    if (autoRestart && code !== 0 && restartCount[key] < 10) {
      log('WARN', `${config.name} crashed, restarting...`);
      notify('OpenCLAW', `${config.name} restarting...`);
      setTimeout(() => spawnProcess(key, config), 3000);
    }
  });
  
  proc.on('error', err => { log('ERROR', `${config.name} error`, { error: err.message }); status[key].running = false; status[key].error = err.message; });
  processes[key] = proc;
  status[key].running = true;
  status[key].error = null;
  status[key].lastCheck = new Date().toISOString();
  status[key].restarts = restartCount[key];
  log('INFO', `${config.name} started, PID: ${proc.pid}`);
}

function killProcess(key) {
  if (processes[key]) { try { processes[key].kill(); log('INFO', `${key} killed`); } catch(e) { log('ERROR', `Kill failed: ${e.message}`); } processes[key] = null; status[key].running = false; }
}

function checkChromeRunning(callback) {
  exec('tasklist | findstr chrome.exe', (err, stdout) => {
    callback(!!stdout && stdout.includes('chrome.exe'));
  });
}

// Check real browser relay status using openclaw CLI
function getBrowserRelayStatus(callback) {
  exec('openclaw browser status', (err, stdout) => {
    if (err || !stdout) {
      callback({ running: false, connected: false });
      return;
    }
    const isRunning = stdout.includes('running: true');
    callback({ running: isRunning, connected: isRunning });
  });
}

// Track previous relay state for change detection
let lastRelayConnected = null;

function checkBrowserHealth() {
  getBrowserRelayStatus((browserStatus) => {
    const wasConnected = lastRelayConnected;
    const isConnected = browserStatus.connected;
    
    // Detect disconnection
    if (wasConnected === true && isConnected === false) {
      log('WARN', 'Browser Relay disconnected!');
      notify('OpenCLAW', 'Browser Relay disconnected! Please reconnect.');
    }
    
    lastRelayConnected = isConnected;
    
    // Update status
    status.browser.running = browserStatus.running;
    if (browserStatus.running) {
      status.browser.lastCheck = new Date().toISOString();
    } else if (status.browser.running && status.browser.lastCheck) {
      // Browser was running but now stopped - restart it
      spawnProcess('browser', CONFIG.browser);
    }
  });
}

function healthCheck() {
  if (!autoRestart) return;
  
  // Check browser relay status with change detection
  checkBrowserHealth();
  
  // Check other processes
  Object.keys(CONFIG).forEach(key => {
    if (key === 'port' || key === 'checkInterval' || key === 'browser') return;
    const config = CONFIG[key];
    
    if (processes[key] && status[key].running) { status[key].lastCheck = new Date().toISOString(); }
    else if (!status[key].running && status[key].lastCheck) { spawnProcess(key, config); }
  });
}

function startServer() {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    const url = req.url.split('?')[0];
    
    if (url === '/api/status') { 
      // Get real browser relay status
      getBrowserRelayStatus((browserStatus) => {
        res.writeHead(200, { 'Content-Type': 'application/json' }); 
        res.end(JSON.stringify({ 
          status, 
          uptime: process.uptime(), 
          relayConnected: browserStatus.connected,
          relayRunning: browserStatus.running,
          config: { gatewayToken: process.env.GATEWAY_TOKEN || '' } 
        })); 
      });
      return; 
    }
    if (url === '/api/start' && req.method === 'POST') { let body = ''; req.on('data', c => body += c); req.on('end', () => { const {key} = JSON.parse(body); restartCount[key] = 0; if (CONFIG[key]) spawnProcess(key, CONFIG[key]); res.writeHead(200); res.end('{"success":true}'); }); return; }
    if (url === '/api/stop' && req.method === 'POST') { let body = ''; req.on('data', c => body += c); req.on('end', () => { const {key} = JSON.parse(body); killProcess(key); res.writeHead(200); res.end('{"success":true}'); }); return; }
    if (url === '/api/start-all') { Object.keys(CONFIG).forEach(k => { if (k !== 'port' && k !== 'checkInterval') { restartCount[k] = 0; spawnProcess(k, CONFIG[k]); } }); res.writeHead(200); res.end('{"success":true}'); return; }
    if (url === '/api/stop-all') { autoRestart = false; Object.keys(CONFIG).forEach(k => { if (k !== 'port' && k !== 'checkInterval') killProcess(k); }); res.writeHead(200); res.end('{"success":true}'); return; }
    if (url === '/' || url === '/index.html') { fs.readFile(htmlPath, (err, data) => { if (err) { res.writeHead(500); res.end('Error'); return; } res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data); }); return; }
    res.writeHead(404); res.end('Not Found');
  });
  server.listen(CONFIG.port, () => { log('INFO', `Dashboard on port ${CONFIG.port}`); notify('OpenCLAW Service', `Port ${CONFIG.port}`); });
}

log('INFO', '========== OpenCLAW Service Starting ==========');

// Validate required environment variables
if (!process.env.SSH_KEY_PATH || !process.env.SSH_HOST) {
  log('ERROR', 'Missing required env vars: SSH_KEY_PATH, SSH_HOST');
  console.error('ERROR: Set SSH_KEY_PATH and SSH_HOST environment variables');
  process.exit(1);
}

killPort(18789, () => { killPort(18888, () => {
  startServer();
  setTimeout(() => { spawnProcess('ssh', CONFIG.ssh); }, 1000);
  setTimeout(() => { spawnProcess('node', CONFIG.node); }, 4000);
  setTimeout(() => { spawnProcess('browser', CONFIG.browser); }, 8000);
  setInterval(healthCheck, CONFIG.checkInterval);
}); });

process.on('SIGINT', () => { log('INFO', 'Shutting down...'); autoRestart = false; Object.keys(processes).forEach(k => killProcess(k)); process.exit(); });
