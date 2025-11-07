const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const cors = require('cors');
const os = require('os');

const app = express();
app.use(cors());

// ★ 証明書は「certs」など配信外ディレクトリに置く（同階層でもOKだが static で配らないこと）
const SSL_OPTIONS = {
  key: fs.readFileSync(path.join(__dirname, 'private-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'certificate.pem')),
};

const PORT = 8443;
const server = https.createServer(SSL_OPTIONS, app);
const wss = new WebSocket.Server({ server });

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
const LOCAL_IP = getLocalIP();

const cameras = new Map(); // cameraId -> { ws, lastFrame, name }
const viewers = new Set();

console.clear();
console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('\x1b[36m%s\x1b[0m', '        📹 OguWatcher (HTTPS)');
console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('\x1b[33m%s\x1b[0m', '✓ HTTPSサーバー起動');
console.log('');
console.log('\x1b[32m%s\x1b[0m', '【iPad/スマホでアクセス】');
console.log('');
console.log('\x1b[35m%s\x1b[0m', `   https://${LOCAL_IP}:${PORT}/camera.html`);
console.log('');
console.log('\x1b[33m%s\x1b[0m', '※初回は証明書の警告が出ます → 「詳細」→「続ける」');
console.log('');
console.log('【PCで確認】');
console.log(`   https://${LOCAL_IP}:${PORT}/viewer`);
console.log('');
console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

// ★ 不要な全公開はやめる。必要なファイルだけ配信
app.get('/camera.html', (_req, res) => {
  res.sendFile(path.join(__dirname, 'camera.html'));
});

app.get('/viewer', (_req, res) => {
  res.send(getViewerHTML());
});

// ===== WebSocket =====

// 接続単位の状態を持つ
function initWsState(ws) {
  ws.role = null; // 'camera' | 'viewer'
  ws.pending = null; // 直後のバイナリが何か: { kind: 'video', cameraId? }
  ws.cameraId = null;
}

wss.on('connection', (ws, req) => {
  initWsState(ws);
  console.log('新規接続');

  ws.on('message', (data, isBinary) => {
    try {
      if (!isBinary) {
        // テキスト（JSON）
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'camera-init': {
            ws.role = 'camera';
            ws.cameraId = msg.cameraId;
            cameras.set(msg.cameraId, {
              ws,
              lastFrame: null,
              name: msg.name || msg.cameraId,
            });
            console.log(`✓ カメラ接続: ${msg.name} (${msg.cameraId})`);
            broadcastCameraList();
            break;
          }

          case 'viewer-init': {
            ws.role = 'viewer';
            viewers.add(ws);
            console.log('✓ ビューアー接続');
            sendCameraList(ws);
            break;
          }

          case 'video': {
            // 直後のバイナリは映像フレーム
            ws.pending = { kind: 'video', cameraId: msg.cameraId };
            break;
          }

          default:
            // 未知タイプは握りつぶし
            break;
        }
      } else {
        // バイナリ到着：直前の JSON で pending を確定させている想定
        const p = ws.pending;
        ws.pending = null; // 一回使い切り

        if (!p) return;

        if (p.kind === 'video') {
          const cam = cameras.get(p.cameraId);
          if (cam) cam.lastFrame = data;

          // 全ビューアに通知 → バイナリ
          broadcastToViewers([
            JSON.stringify({ type: 'video', cameraId: p.cameraId }),
            data,
          ]);
        } 
      }
    } catch (err) {
      console.error('メッセージ処理エラー:', err);
    }
  });

  ws.on('close', () => {
    if (ws.role === 'camera' && ws.cameraId) {
      const cam = cameras.get(ws.cameraId);
      cameras.delete(ws.cameraId);
      console.log(`✗ カメラ切断: ${cam ? cam.name : ws.cameraId}`);
      broadcastCameraList();
    }
    if (ws.role === 'viewer') {
      viewers.delete(ws);
      console.log('✗ ビューアー切断');
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocketエラー:', error);
  });
});

function broadcastToViewers(payloads /* array of buffers/strings */) {
  viewers.forEach((viewer) => {
    if (viewer.readyState !== WebSocket.OPEN) return;
    try {
      for (const p of payloads) viewer.send(p);
    } catch (e) {
      console.error('ビューアー送信エラー:', e);
    }
  });
}

function broadcastCameraList() {
  const list = Array.from(cameras.entries()).map(([id, data]) => ({
    id,
    name: data.name,
  }));
  const message = JSON.stringify({ type: 'camera-list', cameras: list });

  viewers.forEach((viewer) => {
    if (viewer.readyState === WebSocket.OPEN) viewer.send(message);
  });
}

function sendCameraList(viewer) {
  const list = Array.from(cameras.entries()).map(([id, data]) => ({
    id,
    name: data.name,
  }));
  viewer.send(JSON.stringify({ type: 'camera-list', cameras: list }));
}

setInterval(() => {
  console.log(`接続状況 - カメラ: ${cameras.size}台 / ビューアー: ${viewers.size}台`);
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('サーバー稼働中...\n');
});

// ===== Viewer HTML =====
function getViewerHTML() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<title>OguWatcher</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#fff}
.header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:20px 30px;display:flex;justify-content:space-between;align-items:center}
.header-left{display:flex;align-items:center;gap:15px}
.logo{font-size:32px}
.header h1{font-size:26px;font-weight:700}
.camera-count{font-size:24px;font-weight:700;color:#4CAF50}
.camera-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(450px,1fr));gap:20px;padding:20px}
.camera-box{background:#1a1a1a;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.5)}
.camera-header{background:#252525;padding:12px 18px;display:flex;justify-content:space-between}
.camera-view{width:70vw;aspect-ratio: 16 / 9;background:#000;position:relative}
.camera-view img{width:100%;height:100%;object-fit:cover}
.no-cameras{text-align:center;padding:80px 20px;color:#666}
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="logo">📹</div>
      <div><h1>OguWatcher</h1></div>
    </div>
    <div id="cameraCount" class="camera-count">0</div>
  </div>

  <div class="camera-grid" id="cameraGrid">
    <div class="no-cameras">カメラを待機中...</div>
  </div>

<script>
const ws = new WebSocket('wss://' + window.location.hostname + ':${PORT}');
const cameras = new Map();
let currentFrameCameraId = null;
let currentAudioCameraId = null;

ws.onopen = () => ws.send(JSON.stringify({ type: 'viewer-init' }));
ws.onmessage = (event) => {
  if (typeof event.data === 'string') {
    const data = JSON.parse(event.data);
    if (data.type === 'camera-list') updateCameraList(data.cameras);
    else if (data.type === 'video') currentFrameCameraId = data.cameraId;
    else if (data.type === 'audio-from-camera') {
      currentAudioCameraId = data.cameraId;
      ensureAudioSink(currentAudioCameraId);
    }
  } else {
    if (currentFrameCameraId) {
      updateCameraImage(currentFrameCameraId, URL.createObjectURL(event.data));
      currentFrameCameraId = null;
    } else if (currentAudioCameraId) {
      playIncomingAudio(currentAudioCameraId, event.data);
      currentAudioCameraId = null;
    }
  }
};

function updateCameraList(list) {
  const grid = document.getElementById('cameraGrid');
  if (list.length === 0) {
    grid.innerHTML = '<div class="no-cameras">カメラを待機中...</div>';
    document.getElementById('cameraCount').textContent = '0';
    return;
  }
  list.forEach(cam => {
    if (!cameras.has(cam.id)) {
      cameras.set(cam.id, cam);
      const box = document.createElement('div');
      box.className = 'camera-box';
      box.id = 'camera-' + cam.id;
      box.innerHTML = \`
        <div class="camera-header"><div>\${cam.name}</div></div>
        <div class="camera-view">
          <img id="img-\${cam.id}">
        </div>\`;
      if (grid.querySelector('.no-cameras')) grid.innerHTML = '';
      grid.appendChild(box);
    }
  });
  document.getElementById('cameraCount').textContent = cameras.size;
}

function updateCameraImage(id, url) {
  const img = document.getElementById('img-' + id);
  if (!img) return;
  if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.src = url;
}

</script>
</body>
</html>`;
}
