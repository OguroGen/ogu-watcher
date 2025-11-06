const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const os = require('os');

const app = express();
app.use(cors());

const server = http.createServer(app);
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
const HOSTNAME = os.hostname();
const PORT = 8080;

const cameras = new Map();
const viewers = new Set();

console.clear();
console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('\x1b[36m%s\x1b[0m', '        📹 OguWatcher');
console.log('\x1b[36m%s\x1b[0m', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('\x1b[33m%s\x1b[0m', '✓ サーバー起動しました');
console.log('');
console.log('\x1b[32m%s\x1b[0m', '【iPadでアクセス - 以下を試してください】');
console.log('');
console.log('\x1b[35m%s\x1b[0m', `方法1: http://${HOSTNAME}.local:${PORT}/camera.html`);
console.log('\x1b[35m%s\x1b[0m', `方法2: http://${LOCAL_IP}:${PORT}/camera.html`);
console.log('');
console.log('\x1b[33m%s\x1b[0m', '※方法1が推奨（localhostとして認識されカメラが使える）');
console.log('');
console.log('【PCでの確認】');
console.log(`http://${LOCAL_IP}:${PORT}/viewer`);
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
        body {
            font-family: -apple-system, sans-serif;
            background: #0f0f0f;
            color: #fff;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px 30px;
            box-shadow: 0 2px 20px rgba(0,0,0,0.3);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header-left {
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .logo { font-size: 32px; }
        .header h1 { font-size: 26px; font-weight: 700; }
        .subtitle { font-size: 13px; opacity: 0.9; margin-top: 2px; }
        .header-right {
            display: flex;
            align-items: center;
            gap: 20px;
        }
        .connection-info { text-align: right; font-size: 14px; }
        .camera-count { font-size: 24px; font-weight: 700; color: #4CAF50; }
        .camera-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(450px, 1fr));
            gap: 20px;
            padding: 20px;
            min-height: calc(100vh - 160px);
        }
        .camera-box {
            background: #1a1a1a;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            position: relative;
            transition: transform 0.2s;
        }
        .camera-box:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(0,0,0,0.6);
        }
        .camera-header {
            background: #252525;
            padding: 12px 18px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .camera-name { font-weight: 600; font-size: 15px; }
        .camera-status {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
        }
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #4CAF50;
            animation: pulse-dot 2s infinite;
        }
        @keyframes pulse-dot {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.6; transform: scale(1.1); }
        }
        .status-dot.offline { background: #666; animation: none; }
        .camera-view {
            width: 100%;
            height: 340px;
            background: #000;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
        }
        .camera-view img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
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
            font-size: 14px;
            font-weight: 600;
            box-shadow: 0 4px 12px rgba(76, 175, 80, 0.4);
            user-select: none;
            z-index: 10;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .talk-button:hover {
            background: linear-gradient(135deg, #45a049 0%, #3d8b40 100%);
            transform: scale(1.05);
        }
        .talk-button.transmitting {
            background: linear-gradient(135deg, #f44336 0%, #d32f2f 100%);
            animation: pulse-talk 1s infinite;
        }
        @keyframes pulse-talk {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.85; }
        }
        .footer {
            background: #1a1a1a;
            padding: 15px 30px;
            text-align: center;
            font-size: 12px;
            color: #888;
            border-top: 1px solid #333;
        }
        .no-cameras {
            grid-column: 1 / -1;
            text-align: center;
            padding: 80px 20px;
            color: #666;
        }
        .no-cameras-icon { font-size: 64px; margin-bottom: 20px; opacity: 0.5; }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-left">
            <div class="logo">📹</div>
            <div>
                <h1>OguWatcher</h1>
                <div class="subtitle">そろばん教室監視システム</div>
            </div>
        </div>
        <div class="header-right">
            <div class="connection-info">
                <div style="font-size: 12px; color: #aaa;">接続カメラ数</div>
                <div class="camera-count" id="cameraCount">0</div>
            </div>
        </div>
    </div>
    
    <div class="camera-grid" id="cameraGrid">
        <div class="no-cameras">
            <div class="no-cameras-icon">📹</div>
            <div style="font-size: 18px; margin-bottom: 10px;">カメラを待機中...</div>
            <div style="font-size: 14px; color: #555;">iPadでカメラを接続してください</div>
        </div>
    </div>
    
    <div class="footer">
        <div id="timestamp"></div>
    </div>

    <script>
        const SERVER_URL = 'ws://' + window.location.hostname + ':${PORT}';
        let ws = null;
        const cameras = new Map();
        let currentFrameCameraId = null;
        let currentAudioCameraId = null;
        const cameraAudios = new Map();
        let talkingCameraId = null;
        let talkAudioRecorder = null;
        let talkAudioStream = null;

        function init() {
            connectWebSocket();
            setInterval(updateTime, 1000);
        }

        function connectWebSocket() {
            ws = new WebSocket(SERVER_URL);
            ws.onopen = () => {
                ws.send(JSON.stringify({ type: 'viewer-init' }));
            };
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
                    } else if (currentAudioCameraId) {
                        playCameraAudio(currentAudioCameraId, event.data);
                        currentAudioCameraId = null;
                    }
                }
            };
            ws.onclose = () => setTimeout(connectWebSocket, 3000);
        }

        function updateCameraList(cameraList) {
            const grid = document.getElementById('cameraGrid');
            if (cameraList.length === 0) {
                grid.innerHTML = '<div class="no-cameras"><div class="no-cameras-icon">📹</div><div style="font-size: 18px;">カメラを待機中...</div></div>';
                document.getElementById('cameraCount').textContent = '0';
                return;
            }
            cameraList.forEach(camera => {
                if (!cameras.has(camera.id)) {
                    cameras.set(camera.id, camera);
                    addCameraBox(camera);
                }
            });
            cameras.forEach((_, id) => {
                if (!cameraList.find(c => c.id === id)) {
                    removeCameraBox(id);
                    cameras.delete(id);
                }
            });
            document.getElementById('cameraCount').textContent = cameras.size;
        }

        function addCameraBox(camera) {
            const grid = document.getElementById('cameraGrid');
            const noCamera = grid.querySelector('.no-cameras');
            if (noCamera) noCamera.remove();
            const box = document.createElement('div');
            box.className = 'camera-box';
            box.id = 'camera-' + camera.id;
            box.innerHTML = \\\`
                <div class="camera-header">
                    <div class="camera-name">\\\${camera.name}</div>
                    <div class="camera-status"><div class="status-dot"></div><span>オンライン</span></div>
                </div>
                <div class="camera-view">
                    <img id="img-\\\${camera.id}">
                    <button class="talk-button" id="talk-\\\${camera.id}"
                            onmousedown="startTalking('\\\${camera.id}')"
                            onmouseup="stopTalking('\\\${camera.id}')">
                        <span>🎤</span><span>話す</span>
                    </button>
                </div>
            \\\`;
            grid.appendChild(box);
        }

        function removeCameraBox(id) {
            const box = document.getElementById('camera-' + id);
            if (box) box.remove();
        }

        function updateCameraImage(id, url) {
            const img = document.getElementById('img-' + id);
            if (img) {
                if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
                img.src = url;
            }
        }

        function playCameraAudio(id, blob) {
            let audio = cameraAudios.get(id);
            if (!audio) {
                audio = new Audio();
                audio.volume = 0.8;
                cameraAudios.set(id, audio);
            }
            audio.src = URL.createObjectURL(blob);
            audio.play().catch(() => {});
        }

        async function startTalking(id) {
            if (talkingCameraId) return;
            try {
                talkAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                talkAudioRecorder = new MediaRecorder(talkAudioStream);
                talkAudioRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'audio-from-pc', targetCameraId: id }));
                        ws.send(e.data);
                    }
                };
                talkAudioRecorder.start(100);
                talkingCameraId = id;
                const btn = document.getElementById('talk-' + id);
                btn.classList.add('transmitting');
                btn.innerHTML = '<span>🔴</span><span>送信中</span>';
            } catch (e) {
                alert('マイクエラー: ' + e.message);
            }
        }

        function stopTalking(id) {
            if (!talkingCameraId) return;
            if (talkAudioRecorder) talkAudioRecorder.stop();
            if (talkAudioStream) talkAudioStream.getTracks().forEach(t => t.stop());
            talkingCameraId = null;
            const btn = document.getElementById('talk-' + id);
            btn.classList.remove('transmitting');
            btn.innerHTML = '<span>🎤</span><span>話す</span>';
        }

        function updateTime() {
            document.getElementById('timestamp').textContent = new Date().toLocaleString('ja-JP');
        }

        window.addEventListener('load', init);
    </script>
</body>
</html>`;
}
