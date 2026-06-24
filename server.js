/**
 * 双击守护 - 一体化服务器
 * HTTP 静态文件 + WebSocket 实时通信，同端口部署
 *
 * 核心功能：
 * 1. 设备配对管理（一对一绑定）
 * 2. 实时位置信息转发
 * 3. 紧急预警消息推送
 * 4. 前端静态文件服务
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3456;
const STATIC_DIR = path.join(__dirname, '..', 'app');

// ============ MIME 类型 ============
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ============ 静态文件服务 ============
function serveStatic(req, res) {
  let filePath = path.join(STATIC_DIR, req.url === '/' ? 'index.html' : req.url);

  // 安全检查：防止路径穿越
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // SPA fallback: 未匹配路径返回 index.html
        fs.readFile(path.join(STATIC_DIR, 'index.html'), (err2, data2) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data2);
          }
        });
      } else {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
      return;
    }

    // Service Worker 需要正确的 content-type
    if (filePath.endsWith('sw.js')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
    }
    res.end(data);
  });
}

// ============ HTTP 服务器 ============
const server = http.createServer((req, res) => {
  serveStatic(req, res);
});

// ============ 业务逻辑存储 ============
const pairings = new Map();    // pairingCode -> { deviceA, deviceB, createdAt }
const clientIndex = new Map(); // ws -> { deviceId, pairedWith, pairingCode }

// ============ 工具函数 ============
function generatePairingCode() {
  return crypto.randomInt(100000, 999999).toString();
}
function generateDeviceId() {
  return crypto.randomBytes(8).toString('hex');
}
function pack(type, payload) {
  return JSON.stringify({ type, payload, timestamp: Date.now() });
}
function sendWs(ws, type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(pack(type, payload));
  }
}
function getPairingInfo(ws) {
  const client = clientIndex.get(ws);
  if (!client || !client.pairingCode) return null;
  return pairings.get(client.pairingCode);
}
function getPartner(ws) {
  const pairing = getPairingInfo(ws);
  if (!pairing) return null;
  const client = clientIndex.get(ws);
  if (pairing.deviceA === ws) return pairing.deviceB;
  if (pairing.deviceB === ws) return pairing.deviceA;
  return null;
}

function cleanupPairings() {
  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000;
  for (const [code, pairing] of pairings.entries()) {
    if (now - pairing.createdAt > TTL) {
      sendWs(pairing.deviceA, 'unpaired', { reason: '配对已过期（24小时），请重新配对' });
      sendWs(pairing.deviceB, 'unpaired', { reason: '配对已过期（24小时），请重新配对' });
      clientIndex.delete(pairing.deviceA);
      clientIndex.delete(pairing.deviceB);
      pairings.delete(code);
      console.log(`[清理] 配对 ${code} 已过期`);
    }
  }
}
setInterval(cleanupPairings, 10 * 60 * 1000);

// ============ WebSocket 服务（挂载到同一 HTTP Server） ============
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const deviceId = generateDeviceId();
  clientIndex.set(ws, { deviceId, pairedWith: null, pairingCode: null });

  const clientIP = req.socket.remoteAddress;
  console.log(`[连接] 新设备 ${deviceId} 来自 ${clientIP}`);

  sendWs(ws, 'registered', { deviceId });

  ws.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { sendWs(ws, 'error', { message: '消息格式错误' }); return; }

    const { type, payload } = message;

    switch (type) {
      case 'generate_code': {
        const pairingCode = generatePairingCode();
        const client = clientIndex.get(ws);
        client.pairingCode = pairingCode;
        pairings.set(pairingCode, { deviceA: ws, deviceB: null, createdAt: Date.now() });
        console.log(`[配对] 设备 ${deviceId} 生成配对码: ${pairingCode}`);
        sendWs(ws, 'pairing_code', { code: pairingCode });
        break;
      }

      case 'join_code': {
        const { code } = payload;
        const pairing = pairings.get(code);
        const client = clientIndex.get(ws);

        if (!pairing) { sendWs(ws, 'error', { message: '配对码无效或已过期' }); return; }
        if (pairing.deviceA === ws) { sendWs(ws, 'error', { message: '不能与自己配对' }); return; }
        if (pairing.deviceB && pairing.deviceB !== ws) {
          sendWs(ws, 'error', { message: '该配对码已被占用，一个配对码只能绑定两台设备' });
          return;
        }

        pairing.deviceB = ws;
        client.pairingCode = code;
        const partnerA = clientIndex.get(pairing.deviceA);
        partnerA.pairedWith = client.deviceId;
        client.pairedWith = partnerA.deviceId;

        console.log(`[配对] ✅ ${client.deviceId} <-> ${partnerA.deviceId}`);
        sendWs(pairing.deviceA, 'paired', { partnerId: client.deviceId });
        sendWs(ws, 'paired', { partnerId: partnerA.deviceId });
        break;
      }

      case 'location': {
        const partner = getPartner(ws);
        if (!partner) { sendWs(ws, 'error', { message: '未配对，无法发送位置' }); return; }
        console.log(`[位置] ${clientIndex.get(ws).deviceId} -> ${payload.lat}, ${payload.lng}`);
        sendWs(partner, 'location_received', {
          lat: payload.lat, lng: payload.lng, accuracy: payload.accuracy,
          from: clientIndex.get(ws).deviceId,
        });
        break;
      }

      case 'emergency': {
        const partner = getPartner(ws);
        if (!partner) { sendWs(ws, 'error', { message: '未配对，无法发送预警' }); return; }
        console.log(`[紧急] 🚨 ${clientIndex.get(ws).deviceId} 发送紧急预警`);
        sendWs(partner, 'emergency_alert', {
          from: clientIndex.get(ws).deviceId,
          lat: payload.lat, lng: payload.lng, accuracy: payload.accuracy,
          message: payload.message || '紧急求助！请立即查看我的位置！',
          tapCount: payload.tapCount || 0,
        });
        break;
      }

      case 'unpair': {
        const pairing = getPairingInfo(ws);
        if (!pairing) { sendWs(ws, 'error', { message: '当前没有配对关系' }); return; }
        const client = clientIndex.get(ws);
        const code = client.pairingCode;
        const partner = getPartner(ws);
        if (partner) {
          sendWs(partner, 'unpaired', { reason: '对方解除了配对' });
          const p = clientIndex.get(partner);
          if (p) { p.pairedWith = null; p.pairingCode = null; }
        }
        client.pairedWith = null;
        client.pairingCode = null;
        pairings.delete(code);
        sendWs(ws, 'unpaired', { reason: '已解除配对' });
        break;
      }

      case 'status': {
        const client = clientIndex.get(ws);
        const pairing = getPairingInfo(ws);
        const partner = getPartner(ws);
        sendWs(ws, 'status_response', {
          deviceId: client.deviceId,
          paired: !!partner,
          pairingCode: client.pairingCode,
          partnerId: client.pairedWith,
          partnerOnline: partner && partner.readyState === WebSocket.OPEN,
          role: pairing ? (pairing.deviceA === ws ? 'A' : 'B') : null,
        });
        break;
      }

      default: sendWs(ws, 'error', { message: `未知消息类型: ${type}` });
    }
  });

  ws.on('close', () => {
    const client = clientIndex.get(ws);
    if (!client) return;
    console.log(`[断开] 设备 ${client.deviceId}`);
    const partner = getPartner(ws);
    if (partner) sendWs(partner, 'partner_offline', { deviceId: client.deviceId });
    clientIndex.delete(ws);
  });

  ws.on('error', (err) => console.error(`[错误] ${deviceId}:`, err.message));
});

// ============ 启动 ============
server.listen(PORT, () => {
  console.log('═══════════════════════════════════════');
  console.log('  🚀 双击守护 — 公网版');
  console.log(`  HTTP + WebSocket 一体化服务`);
  console.log(`  端口: ${PORT}`);
  console.log('═══════════════════════════════════════\n');
});

process.on('SIGINT', () => { wss.close(() => server.close(() => process.exit(0))); });
process.on('SIGTERM', () => { wss.close(() => server.close(() => process.exit(0))); });
