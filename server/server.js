/**
 * 双击守护 - 后端 WebSocket 服务器
 * 
 * 核心功能：
 * 1. 设备配对管理（一对一绑定）
 * 2. 实时位置信息转发
 * 3. 紧急预警消息推送
 */

const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3456;

// 设备配对存储: pairingCode -> { deviceA: ws, deviceB: ws, createdAt }
const pairings = new Map();

// WebSocket 反向索引: ws -> { deviceId, pairedWith, pairingCode }
const clientIndex = new Map();

// ============ 工具函数 ============

/** 生成6位配对码 */
function generatePairingCode() {
  return crypto.randomInt(100000, 999999).toString();
}

/** 生成设备ID */
function generateDeviceId() {
  return crypto.randomBytes(8).toString('hex');
}

/** 包装消息 */
function pack(type, payload) {
  return JSON.stringify({ type, payload, timestamp: Date.now() });
}

/** 发送消息给指定客户端 */
function send(ws, type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(pack(type, payload));
  }
}

/** 获取配对信息 */
function getPairingInfo(ws) {
  const client = clientIndex.get(ws);
  if (!client || !client.pairingCode) return null;
  return pairings.get(client.pairingCode);
}

/** 获取配对的另一端 */
function getPartner(ws) {
  const pairing = getPairingInfo(ws);
  if (!pairing) return null;
  const client = clientIndex.get(ws);
  if (pairing.deviceA === ws) return pairing.deviceB;
  if (pairing.deviceB === ws) return pairing.deviceA;
  return null;
}

/** 清理过期配对（24小时） */
function cleanupPairings() {
  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000;
  for (const [code, pairing] of pairings.entries()) {
    if (now - pairing.createdAt > TTL) {
      // 通知两端解除配对
      send(pairing.deviceA, 'unpaired', { reason: '配对已过期（24小时），请重新配对' });
      send(pairing.deviceB, 'unpaired', { reason: '配对已过期（24小时），请重新配对' });
      clientIndex.delete(pairing.deviceA);
      clientIndex.delete(pairing.deviceB);
      pairings.delete(code);
      console.log(`[清理] 配对 ${code} 已过期，已解除`);
    }
  }
}

// 每10分钟清理一次
setInterval(cleanupPairings, 10 * 60 * 1000);

// ============ WebSocket 服务 ============

const wss = new WebSocket.Server({ port: PORT });

console.log(`🚀 双击守护服务器已启动，端口: ${PORT}`);
console.log(`   WebSocket: ws://localhost:${PORT}`);
console.log(`   等待设备连接...\n`);

wss.on('connection', (ws, req) => {
  const deviceId = generateDeviceId();
  clientIndex.set(ws, { deviceId, pairedWith: null, pairingCode: null });

  const clientIP = req.socket.remoteAddress;
  console.log(`[连接] 新设备 ${deviceId} 来自 ${clientIP}`);

  // 发送设备ID给客户端
  send(ws, 'registered', { deviceId });

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      send(ws, 'error', { message: '消息格式错误' });
      return;
    }

    const { type, payload } = message;

    switch (type) {
      // ===== 生成配对码 =====
      case 'generate_code': {
        const pairingCode = generatePairingCode();
        const client = clientIndex.get(ws);
        client.pairingCode = pairingCode;

        // 创建配对记录（先占位，等对方加入）
        pairings.set(pairingCode, {
          deviceA: ws,
          deviceB: null,
          createdAt: Date.now(),
        });

        console.log(`[配对] 设备 ${deviceId} 生成配对码: ${pairingCode}`);
        send(ws, 'pairing_code', { code: pairingCode });
        break;
      }

      // ===== 输入配对码加入 =====
      case 'join_code': {
        const { code } = payload;
        const pairing = pairings.get(code);
        const client = clientIndex.get(ws);

        if (!pairing) {
          send(ws, 'error', { message: '配对码无效或已过期' });
          return;
        }

        if (pairing.deviceA === ws) {
          send(ws, 'error', { message: '不能与自己配对' });
          return;
        }

        if (pairing.deviceB && pairing.deviceB !== ws) {
          send(ws, 'error', { message: '该配对码已被占用，一个配对码只能绑定两台设备' });
          return;
        }

        // 完成配对
        pairing.deviceB = ws;
        client.pairingCode = code;

        const partnerA = clientIndex.get(pairing.deviceA);
        partnerA.pairedWith = client.deviceId;
        client.pairedWith = partnerA.deviceId;

        const partnerId = partnerA.deviceId;
        console.log(`[配对] ✅ 设备 ${client.deviceId} 与 ${partnerId} 配对成功 (code: ${code})`);

        send(pairing.deviceA, 'paired', { partnerId: client.deviceId });
        send(ws, 'paired', { partnerId });
        break;
      }

      // ===== 发送位置 =====
      case 'location': {
        const partner = getPartner(ws);
        if (!partner) {
          send(ws, 'error', { message: '未配对，无法发送位置' });
          return;
        }
        console.log(`[位置] 设备 ${clientIndex.get(ws).deviceId} -> 分享位置: ${payload.lat}, ${payload.lng}`);
        send(partner, 'location_received', {
          lat: payload.lat,
          lng: payload.lng,
          accuracy: payload.accuracy,
          from: clientIndex.get(ws).deviceId,
        });
        break;
      }

      // ===== 发送紧急预警 =====
      case 'emergency': {
        const partner = getPartner(ws);
        if (!partner) {
          send(ws, 'error', { message: '未配对，无法发送预警' });
          return;
        }
        const senderId = clientIndex.get(ws).deviceId;
        console.log(`[紧急] 🚨 设备 ${senderId} 发送紧急预警！`);
        send(partner, 'emergency_alert', {
          from: senderId,
          message: payload.message || '紧急求助！请立即查看我的位置！',
          tapCount: payload.tapCount || 0,
        });
        break;
      }

      // ===== 解除配对 =====
      case 'unpair': {
        const pairing = getPairingInfo(ws);
        if (!pairing) {
          send(ws, 'error', { message: '当前没有配对关系' });
          return;
        }

        const client = clientIndex.get(ws);
        const code = client.pairingCode;

        // 通知对方
        const partner = getPartner(ws);
        if (partner) {
          send(partner, 'unpaired', { reason: '对方解除了配对' });
          const pClient = clientIndex.get(partner);
          if (pClient) {
            pClient.pairedWith = null;
            pClient.pairingCode = null;
          }
        }

        // 清理自身
        client.pairedWith = null;
        client.pairingCode = null;
        pairings.delete(code);

        console.log(`[配对] 设备 ${deviceId} 解除配对 (code: ${code})`);
        send(ws, 'unpaired', { reason: '已解除配对' });
        break;
      }

      // ===== 检查配对状态 =====
      case 'status': {
        const client = clientIndex.get(ws);
        const pairing = getPairingInfo(ws);
        const partner = getPartner(ws);

        send(ws, 'status_response', {
          deviceId: client.deviceId,
          paired: !!partner,
          pairingCode: client.pairingCode,
          partnerId: client.pairedWith,
          partnerOnline: partner && partner.readyState === WebSocket.OPEN,
          role: pairing ? (pairing.deviceA === ws ? 'A' : 'B') : null,
        });
        break;
      }

      default:
        send(ws, 'error', { message: `未知消息类型: ${type}` });
    }
  });

  ws.on('close', () => {
    const client = clientIndex.get(ws);
    if (!client) return;

    console.log(`[断开] 设备 ${client.deviceId} 断开连接`);

    // 通知配对设备自己已下线
    const partner = getPartner(ws);
    if (partner) {
      send(partner, 'partner_offline', { deviceId: client.deviceId });
    }

    // 不立即清除配对关系 —— 允许设备重连后恢复
    // 只标记下线，配对信息保留
    clientIndex.delete(ws);
  });

  ws.on('error', (err) => {
    console.error(`[错误] 设备 ${deviceId}:`, err.message);
  });
});

// ============ 优雅退出 ============

process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  wss.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  wss.close(() => {
    process.exit(0);
  });
});
