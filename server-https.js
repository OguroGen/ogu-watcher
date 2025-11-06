const express = require('express');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const cors = require('cors');
const os = require('os');

const app = express();
app.use(cors());

// SSL証明書の読み込み
const SSL_OPTIONS = {
    key: fs.readFileSync('./private-key.pem'),
    cert: fs.readFileSync('./certificate.pem')
};

const server = https.createServer(SSL_OPTIONS, app);
const wss = new WebSocket.Server({ server });

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const LOCAL_IP = getLocalIP();
const PORT = 8443;

const cameras = new Map();
const viewers = new Set();

console.clear();
console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('\x1b[36m%s\x1b[0m', '        📹 OguWatcher (HTTPS)');
console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('\x1b[33m%s\x1b[0m', '✓ HTTPSサーバー起動');
console.log('');
console.log('\x1b[32m%s\x1b[0m', '【iPadでアクセス】');
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

app.use(express.static(__dirname));

app.get('/viewer', (req, res) => {
    res.send(getViewerHTML());
});

let expectingVideoData = false;
let expectingCameraAudioData = false;
let expectingPCAudioData = false;
let currentCameraId = null;
let targetCameraId = null;

wss.on('connection', (ws, req) => {
    console.log('新規接続');

    ws.on('message', (message) => {
        try {
            if (message[0] === '{'.charCodeAt(0)) {
                const data = JSON.parse(message.toString());
                
                if (data.type === 'video') {
                    expectingVideoData = true;
                    currentCameraId = data.cameraId;
                    return;
                }
                
                if (data.type === 'audio-from-camera') {
                    expectingCameraAudioData = true;
                    currentCameraId = data.cameraId;
                    return;
                }
                
                if (data.type === 'audio-from-pc') {
                    expectingPCAudioData = true;
                    targetCameraId = data.targetCameraId;
                    return;
                }
                
                if (data.type === 'camera-init') {
                    cameras.set(data.cameraId, {
                        ws: ws,
                        lastFrame: null,
                        name: data.name || data.cameraId
                    });
                    ws.cameraId = data.cameraId;
                    ws.isCamera = true;
                    
                    console.log(`✓ カメラ接続: ${data.name} (${data.cameraId})`);
                    
                    broadcastCameraList();
                    return;
                }
                
                if (data.type === 'viewer-init') {
                    viewers.add(ws);
                    ws.isViewer = true;
                    
                    console.log('✓ ビューアー接続');
                    
                    sendCameraList(ws);
                    return;
                }
            }
            else {
                if (expectingVideoData) {
                    expectingVideoData = false;
                    const camera = cameras.get(currentCameraId);
                    if (camera) {
                        camera.lastFrame = message;
                        
                        viewers.forEach(viewer => {
                            if (viewer.readyState === WebSocket.OPEN) {
                                try {
                                    viewer.send(JSON.stringify({
                                        type: 'video',
                                        cameraId: currentCameraId
                                    }));
                                    viewer.send(message);
                                } catch (error) {
                                    console.error('映像送信エラー:', error);
                                }
                            }
                        });
                    }
                }
                else if (expectingCameraAudioData) {
                    expectingCameraAudioData = false;
                    
                    viewers.forEach(viewer => {
                        if (viewer.readyState === WebSocket.OPEN) {
                            try {
                                viewer.send(JSON.stringify({
                                    type: 'audio-from-camera',
                                    cameraId: currentCameraId
                                }));
                                viewer.send(message);
                            } catch (error) {
                                console.error('音声送信エラー:', error);
                            }
                        }
                    });
                }
                else if (expectingPCAudioData) {
                    expectingPCAudioData = false;
                    
                    const camera = cameras.get(targetCameraId);
                    if (camera && camera.ws.readyState === WebSocket.OPEN) {
                        try {
                            camera.ws.send(JSON.stringify({ 
                                type: 'audio-from-pc' 
                            }));
                            camera.ws.send(message);
                        } catch (error) {
                            console.error('トーク送信エラー:', error);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('メッセージ処理エラー:', error);
        }
    });

    ws.on('close', () => {
        if (ws.isCamera && ws.cameraId) {
            const camera = cameras.get(ws.cameraId);
            cameras.delete(ws.cameraId);
            console.log(`✗ カメラ切断: ${camera ? camera.name : ws.cameraId}`);
            broadcastCameraList();
        }
        if (ws.isViewer) {
            viewers.delete(ws);
            console.log('✗ ビューアー切断');
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocketエラー:', error);
    });
});

function broadcastCameraList() {
    const list = Array.from(cameras.entries()).map(([id, data]) => ({
        id: id,
        name: data.name
    }));
    
    const message = JSON.stringify({
        type: 'camera-list',
        cameras: list
    });
    
    viewers.forEach(viewer => {
        if (viewer.readyState === WebSocket.OPEN) {
            viewer.send(message);
        }
    });
}

function sendCameraList(viewer) {
    const list = Array.from(cameras.entries()).map(([id, data]) => ({
        id: id,
        name: data.name
    }));
    
    viewer.send(JSON.stringify({
        type: 'camera-list',
        cameras: list
    }));
}

setInterval(() => {
    console.log(`接続状況 - カメラ: ${cameras.size}台 / ビューアー: ${viewers.size}台`);
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
    console.log('サーバー稼働中...\n');
});

function getViewerHTML() {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OguWatcher</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #fff; }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px 30px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header-left { display: flex; align-items: center; gap: 15px; }
        .logo { font-size: 32px; }
        .header h1 { font-size: 26px; font-weight: 700; }
        .camera-count { font-size: 24px; font-weight: 700; color: #4CAF50; }
        .camera-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(450px, 1fr));
            gap: 20px;
            padding: 20px;
        }
        .camera-box {
            background: #1a1a1a;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        }
        .camera-header {
            background: #252525;
            padding: 12px 18px;
            display: flex;
            justify-content: space-between;
        }
        .camera-view {
            width: 100%;
            height: 340px;
            background: #000;
            position: relative;
        }
        .camera-view img { width: 100%; height: 100%; object-fit: cover; }
        .talk-button {
            position: absolute;
            bottom: 15px;
            right: 15px;
            padding: 12px 24px;
            background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
            color: white;
            border: none;
            border-radius: 25px;
            cursor: pointer;
            font-weight: 600;
            z-index: 10;
        }
        .talk-button.transmitting {
            background: linear-gradient(135deg, #f44336 0%, #d32f2f 100%);
        }
        .no-cameras { text-align: center; padding: 80px 20px; color: #666; }
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
                else if (data.type === 'audio-from-camera') currentAudioCameraId = data.cameraId;
            } else {
                if (currentFrameCameraId) {
                    updateCameraImage(currentFrameCameraId, URL.createObjectURL(event.data));
                    currentFrameCameraId = null;
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
                    box.innerHTML = \\\`
                        <div class="camera-header"><div>\\\${cam.name}</div></div>
                        <div class="camera-view">
                            <img id="img-\\\${cam.id}">
                            <button class="talk-button" id="talk-\\\${cam.id}"
                                onmousedown="startTalking('\\\${cam.id}')"
                                onmouseup="stopTalking('\\\${cam.id}')">🎤 話す</button>
                        </div>
                    \\\`;
                    if (grid.querySelector('.no-cameras')) grid.innerHTML = '';
                    grid.appendChild(box);
                }
            });
            document.getElementById('cameraCount').textContent = cameras.size;
        }

        function updateCameraImage(id, url) {
            const img = document.getElementById('img-' + id);
            if (img) {
                if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
                img.src = url;
            }
        }

        let talkingCameraId = null;
        let talkRecorder = null;
        let talkStream = null;

        async function startTalking(id) {
            if (talkingCameraId) return;
            try {
                talkStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                talkRecorder = new MediaRecorder(talkStream);
                talkRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) {
                        ws.send(JSON.stringify({ type: 'audio-from-pc', targetCameraId: id }));
                        ws.send(e.data);
                    }
                };
                talkRecorder.start(100);
                talkingCameraId = id;
                document.getElementById('talk-' + id).classList.add('transmitting');
                document.getElementById('talk-' + id).textContent = '🔴 送信中';
            } catch (e) { alert('マイクエラー'); }
        }

        function stopTalking(id) {
            if (!talkingCameraId) return;
            if (talkRecorder) talkRecorder.stop();
            if (talkStream) talkStream.getTracks().forEach(t => t.stop());
            talkingCameraId = null;
            document.getElementById('talk-' + id).classList.remove('transmitting');
            document.getElementById('talk-' + id).textContent = '🎤 話す';
        }
    </script>
</body>
</html>`;
}
