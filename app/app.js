/**
 * 双击守护 - 前端核心逻辑
 * 
 * 功能：
 * 1. WebSocket 实时通信
 * 2. 设备配对管理
 * 3. 双击检测 → 发送位置
 * 4. 连续敲击检测 → 紧急预警
 * 5. 定位获取
 */

// ============ 配置 ============
const CONFIG = {
  // 从 localStorage 读取自定义 WebSocket URL，否则自动匹配
  get WS_URL() {
    const saved = localStorage.getItem('taptap_ws_url');
    if (saved) return saved;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  },
  set WS_URL(val) {
    if (val) {
      localStorage.setItem('taptap_ws_url', val);
    } else {
      localStorage.removeItem('taptap_ws_url');
    }
  },
  get isCustomUrl() {
    return !!localStorage.getItem('taptap_ws_url');
  },
  get defaultUrl() {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  },
  DOUBLE_TAP_WINDOW: 500,     // 双击检测窗口(ms)
  RAPID_TAP_WINDOW: 2000,     // 连续敲击检测窗口(ms)
  RAPID_TAP_THRESHOLD: 5,      // 连续敲击触发阈值(次)
  TAP_COOLDOWN: 3000,         // 位置发送冷却时间(ms)
  RECONNECT_DELAY: 3000,       // 重连延迟(ms)
  MAX_RECONNECT_DELAY: 30000,  // 最大重连延迟(ms)
  LOCATION_TIMEOUT: 10000,     // 获取定位超时(ms)
};

// ============ 状态管理 ============
const state = {
  ws: null,
  deviceId: null,
  paired: false,
  partnerId: null,
  pairingCode: null,
  partnerOnline: false,
  reconnectAttempts: 0,
  reconnectTimer: null,

  // 点击状态
  tapCount: 0,
  tapTimer: null,
  lastTapTime: 0,
  locationCooldown: false,

  // 最近一次位置
  lastLocation: null,
};

// ============ DOM 引用 ============
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const DOM = {
  connectionStatus: $('#connection-status'),
  unpairedView: $('#unpaired-view'),
  pairedView: $('#paired-view'),
  btnGenerateCode: $('#btn-generate-code'),
  pairingCodeDisplay: $('#pairing-code-display'),
  codeNumber: $('#code-number'),
  btnCopyCode: $('#btn-copy-code'),
  inputPairingCode: $('#input-pairing-code'),
  btnJoinCode: $('#btn-join-code'),
  joinError: $('#join-error'),
  partnerName: $('#partner-name'),
  partnerStatus: $('#partner-status'),
  partnerAvatar: $('#partner-avatar-text'),
  btnUnpair: $('#btn-unpair'),
  tapCircle: $('#tap-circle'),
  tapRipple: $('#tap-ripple'),
  tapCountEl: $('#tap-count'),
  tapCounter: $('#tap-counter'),
  tapProgressBar: $('#tap-progress-bar'),
  tapProgressFill: $('#tap-progress-fill'),
  actionHint: $('#action-hint'),
  eventLog: $('#event-log'),
  emergencyOverlay: $('#emergency-overlay'),
  emergencyTitle: $('#emergency-title'),
  emergencyMessage: $('#emergency-message'),
  emergencyLocation: $('#emergency-location'),
  btnDismissEmergency: $('#btn-dismiss-emergency'),
  bottomNav: $('#bottom-nav'),
  navEmergencyBtn: $('#nav-emergency-send'),
  toast: $('#toast'),
  // 设置相关
  settingsOverlay: $('#settings-overlay'),
  btnOpenSettings: $('#btn-open-settings'),
  btnCloseSettings: $('#btn-close-settings'),
  btnSaveSettings: $('#btn-save-settings'),
  btnResetSettings: $('#btn-reset-settings'),
  inputWsUrl: $('#input-ws-url'),
  settingsStatus: $('#settings-status'),
};

// ============ Toast 提示 ============
let toastTimer = null;
function showToast(message, type = 'info', duration = 2500) {
  const t = DOM.toast;
  t.textContent = message;
  t.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add('hidden');
  }, duration);
}

// ============ 日志记录 ============
function addLog(type, text) {
  const log = DOM.eventLog;
  // 移除空状态提示
  const empty = log.querySelector('.log-empty');
  if (empty) empty.remove();

  const now = new Date();
  const time = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const item = document.createElement('div');
  item.className = `log-item ${type}`;
  item.innerHTML = `<span class="log-time">${time}</span><span class="log-text">${text}</span>`;

  log.prepend(item);

  // 最多保留20条
  while (log.children.length > 20) {
    log.lastChild.remove();
  }
}

// ============ WebSocket 连接 ============
function connectWebSocket() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return;

  console.log(`[WS] 连接中: ${CONFIG.WS_URL}`);
  updateConnectionStatus('connecting', '连接中...');

  try {
    state.ws = new WebSocket(CONFIG.WS_URL);
  } catch (e) {
    console.error('[WS] 创建连接失败:', e);
    scheduleReconnect();
    return;
  }

  state.ws.onopen = () => {
    console.log('[WS] 已连接');
    state.reconnectAttempts = 0;
    updateConnectionStatus('connected', '已连接');

    // 如果之前有配对码，重新查询状态
    if (state.pairingCode || state.paired) {
      sendMessage('status', {});
    }
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error('[WS] 消息解析失败:', e);
    }
  };

  state.ws.onclose = (event) => {
    console.log(`[WS] 断开 (code: ${event.code})`);
    updateConnectionStatus('disconnected', '已断开');
    scheduleReconnect();
  };

  state.ws.onerror = (err) => {
    console.error('[WS] 错误:', err);
  };
}

function scheduleReconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);

  const delay = Math.min(
    CONFIG.RECONNECT_DELAY * Math.pow(1.5, state.reconnectAttempts),
    CONFIG.MAX_RECONNECT_DELAY
  );
  state.reconnectAttempts++;

  console.log(`[WS] ${delay/1000}秒后重连 (第${state.reconnectAttempts}次)`);
  updateConnectionStatus('connecting', `重连中(${state.reconnectAttempts})...`);

  state.reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, delay);
}

function sendMessage(type, payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    showToast('未连接到服务器，请检查网络', 'error');
    return false;
  }
  state.ws.send(JSON.stringify({ type, payload }));
  return true;
}

function updateConnectionStatus(status, label) {
  const el = DOM.connectionStatus;
  el.className = `status-dot ${status}`;
  el.querySelector('.label').textContent = label;
}

// ============ 消息处理 ============
function handleMessage(msg) {
  const { type, payload } = msg;

  switch (type) {
    case 'registered':
      state.deviceId = payload.deviceId;
      console.log('[注册] 设备ID:', state.deviceId);
      addLog('system', `设备已注册 (${state.deviceId.slice(0, 8)}...)`);
      break;

    case 'pairing_code':
      state.pairingCode = payload.code;
      DOM.codeNumber.textContent = payload.code;
      DOM.pairingCodeDisplay.classList.remove('hidden');
      showToast(`配对码已生成: ${payload.code}`, 'success');
      addLog('system', `生成配对码: ${payload.code}`);
      break;

    case 'paired':
      state.paired = true;
      state.partnerId = payload.partnerId;
      state.partnerOnline = true;
      switchToPairedView();
      showToast('配对成功！设备已绑定', 'success');
      addLog('system', '配对成功，设备已绑定');
      break;

    case 'unpaired':
      state.paired = false;
      state.partnerId = null;
      state.pairingCode = null;
      state.partnerOnline = false;
      switchToUnpairedView();
      showToast(payload.reason || '配对已解除', 'warning');
      addLog('system', payload.reason || '配对已解除');
      break;

    case 'location_received':
      handleLocationReceived(payload);
      break;

    case 'emergency_alert':
      handleEmergencyAlert(payload);
      break;

    case 'partner_offline':
      state.partnerOnline = false;
      DOM.partnerStatus.textContent = '离线';
      DOM.partnerStatus.classList.add('offline');
      DOM.partnerAvatar.textContent = '👤';
      addLog('system', '对方设备已离线');
      break;

    case 'status_response':
      if (payload.paired) {
        state.paired = true;
        state.partnerId = payload.partnerId;
        state.partnerOnline = payload.partnerOnline;
        state.pairingCode = payload.pairingCode;
        switchToPairedView();
        if (!payload.partnerOnline) {
          DOM.partnerStatus.textContent = '离线';
          DOM.partnerStatus.classList.add('offline');
          DOM.partnerAvatar.textContent = '👤';
        }
      }
      break;

    case 'error':
      showToast(payload.message, 'error');
      console.error('[错误]', payload.message);
      break;
  }
}

// ============ 位置分享 ============
function handleLocationReceived(data) {
  const { lat, lng, accuracy } = data;

  state.lastLocation = { lat, lng, accuracy };

  const latStr = lat.toFixed(6);
  const lngStr = lng.toFixed(6);
  const mapsUrl = `https://www.google.com/maps?q=${latStr},${lngStr}`;

  addLog('location', `收到位置: ${latStr}, ${lngStr}`);

  // 创建 Google Maps 和 Apple Maps 链接
  const appleMapsUrl = `https://maps.apple.com/?q=${latStr},${lngStr}`;

  showToast(`📍 收到对方位置`, 'info', 3000);

  // 短暂显示位置信息在界面上
  DOM.emergencyTitle.textContent = '📍 对方位置';
  DOM.emergencyMessage.innerHTML = `
    对方正在查看此位置<br><br>
    <a href="${mapsUrl}" target="_blank" rel="noopener" 
       style="color:#ff6b81;font-size:0.85rem;">
      🗺️ 在 Google 地图中查看
    </a><br>
    <a href="${appleMapsUrl}" target="_blank" rel="noopener"
       style="color:#ff6b81;font-size:0.85rem;">
      🍎 在 Apple 地图中查看
    </a>
  `;
  DOM.emergencyLocation.innerHTML = `
    📍 ${latStr}, ${lngStr}<br>
    <small>精度: ±${Math.round(accuracy)}m</small>
  `;
  DOM.emergencyOverlay.classList.remove('hidden');

  // 3秒后自动关闭
  setTimeout(() => {
    if (!DOM.emergencyOverlay.classList.contains('hidden') &&
        DOM.emergencyTitle.textContent === '📍 对方位置') {
      DOM.emergencyOverlay.classList.add('hidden');
    }
  }, 5000);
}

// ============ 紧急预警 ============
function handleEmergencyAlert(data) {
  const { lat, lng, message, from } = data;

  DOM.emergencyTitle.textContent = '🚨 紧急预警';
  DOM.emergencyMessage.textContent = message || '对方发送了紧急求助！请立即联系或查看其位置。';

  if (lat && lng) {
    const mapsUrl = `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
    DOM.emergencyLocation.innerHTML = `
      📍 最后位置: ${lat.toFixed(6)}, ${lng.toFixed(6)}<br>
      <a href="${mapsUrl}" target="_blank" rel="noopener">🗺️ 查看地图</a>
    `;
  } else {
    DOM.emergencyLocation.innerHTML = '位置信息不可用';
  }

  DOM.emergencyOverlay.classList.remove('hidden');
  addLog('emergency', '🚨 收到紧急预警！');

  // 振动（如果设备支持）
  if (navigator.vibrate) {
    navigator.vibrate([500, 200, 500, 200, 500]);
  }

  // 播放警报音
  playAlertSound();
}

// ============ 获取定位 ============
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('设备不支持定位功能'));
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error('获取定位超时，请检查定位权限'));
    }, CONFIG.LOCATION_TIMEOUT);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timeout);
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => {
        clearTimeout(timeout);
        let msg = '定位失败';
        switch (err.code) {
          case err.PERMISSION_DENIED:
            msg = '定位权限被拒绝，请在设置中允许位置访问';
            break;
          case err.POSITION_UNAVAILABLE:
            msg = '位置信息不可用';
            break;
          case err.TIMEOUT:
            msg = '获取定位超时';
            break;
        }
        reject(new Error(msg));
      },
      {
        enableHighAccuracy: true,
        timeout: CONFIG.LOCATION_TIMEOUT - 1000,
        maximumAge: 30000, // 30秒内的缓存位置可用
      }
    );
  });
}

// ============ 发送位置 ============
async function sendLocation() {
  if (state.locationCooldown) {
    showToast('请稍后再发送位置', 'warning', 1500);
    return;
  }

  try {
    showToast('正在获取位置...', 'info', 1500);
    const location = await getCurrentPosition();

    if (sendMessage('location', location)) {
      state.lastLocation = location;
      addLog('location', `已发送位置: ${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`);
      showToast('📍 位置已发送', 'success');

      // 视觉反馈
      DOM.tapCircle.classList.add('location-sent');
      setTimeout(() => DOM.tapCircle.classList.remove('location-sent'), 800);

      // 设置冷却
      state.locationCooldown = true;
      setTimeout(() => { state.locationCooldown = false; }, CONFIG.TAP_COOLDOWN);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============ 发送紧急预警 ============
async function sendEmergency(tapCount) {
  let location = null;
  try {
    location = await getCurrentPosition();
  } catch (e) {
    console.warn('紧急预警：无法获取位置', e.message);
  }

  const payload = {
    message: '紧急求助！请立即查看我的位置并联系我！',
    tapCount,
    ...(location || {}),
  };

  if (sendMessage('emergency', payload)) {
    addLog('emergency', '🚨 紧急预警已发送！');
    showToast('🚨 紧急预警已发送给绑定设备', 'error', 4000);

    // 触发本地振动
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200, 100, 500]);
    }

    // 视觉反馈
    DOM.tapCircle.classList.add('emergency');
    setTimeout(() => DOM.tapCircle.classList.remove('emergency'), 1500);
  }
}

// ============ 点击检测系统 ============
function setupTapDetection() {
  const circle = DOM.tapCircle;

  // 使用 touchstart 以获得最快的响应（比 click 快 ~300ms）
  circle.addEventListener('touchstart', (e) => {
    e.preventDefault(); // 阻止双击缩放
    handleTap();
  });

  // 桌面端使用 click
  circle.addEventListener('click', (e) => {
    e.preventDefault();
    handleTap();
  });

  // 底部紧急按钮也发送预警
  DOM.navEmergencyBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.paired && state.partnerOnline) {
      sendEmergency(5);
    } else if (!state.paired) {
      showToast('请先绑定设备', 'warning');
    } else {
      showToast('对方设备不在线', 'warning');
    }
  });

  // 解除预警按钮
  DOM.btnDismissEmergency.addEventListener('click', () => {
    DOM.emergencyOverlay.classList.add('hidden');
  });
}

function handleTap() {
  const now = Date.now();

  // 如果距离上次点击超过检测窗口，重置计数
  if (now - state.lastTapTime > CONFIG.RAPID_TAP_WINDOW) {
    state.tapCount = 0;
  }

  state.tapCount++;
  state.lastTapTime = now;

  // 更新点击计数显示
  DOM.tapCountEl.textContent = state.tapCount;
  DOM.tapCounter.classList.remove('hidden');

  // 显示进度条
  DOM.tapProgressBar.classList.remove('hidden');
  const progress = Math.min((state.tapCount / CONFIG.RAPID_TAP_THRESHOLD) * 100, 100);
  DOM.tapProgressFill.style.width = `${progress}%`;

  // 涟漪效果
  DOM.tapRipple.classList.remove('animate');
  void DOM.tapRipple.offsetWidth; // reflow
  DOM.tapRipple.classList.add('animate');

  // 添加到活跃状态
  DOM.tapCircle.classList.add('tapping');
  setTimeout(() => DOM.tapCircle.classList.remove('tapping'), 200);

  // 清除之前的定时器
  if (state.tapTimer) clearTimeout(state.tapTimer);

  // 设置定时器来处理点击结束
  state.tapTimer = setTimeout(() => {
    processTapResult();
  }, CONFIG.DOUBLE_TAP_WINDOW + 100); // 给双击足够的时间窗口
}

function processTapResult() {
  const tapCount = state.tapCount;
  const now = Date.now();

  console.log(`[点击] ${tapCount}次点击`);

  if (tapCount <= 0) return;

  if (!state.paired) {
    showToast('请先绑定另一台设备', 'warning');
    resetTapState();
    return;
  }

  if (!state.partnerOnline) {
    showToast('对方设备不在线', 'warning');
    resetTapState();
    return;
  }

  if (tapCount >= CONFIG.RAPID_TAP_THRESHOLD) {
    // 连续敲击 → 紧急预警
    console.log('[点击] 🚨 触发紧急预警');
    sendEmergency(tapCount);
    // 振动反馈
    if (navigator.vibrate) {
      navigator.vibrate(300);
    }
  } else if (tapCount >= 2) {
    // 双击 → 发送位置
    console.log('[点击] 📍 触发位置分享');
    sendLocation();
  } else {
    // 单击 → 提示用户
    showToast('轻敲两下发送位置 / 连续敲击发送预警', 'info', 2000);
  }

  resetTapState();
}

function resetTapState() {
  state.tapCount = 0;
  state.lastTapTime = 0;
  DOM.tapCounter.classList.add('hidden');
  DOM.tapProgressBar.classList.add('hidden');
  DOM.tapProgressFill.style.width = '0%';
  if (state.tapTimer) {
    clearTimeout(state.tapTimer);
    state.tapTimer = null;
  }
}

// ============ 视图切换 ============
function switchToPairedView() {
  DOM.unpairedView.classList.remove('active');
  DOM.pairedView.classList.add('active');
  DOM.bottomNav.classList.remove('hidden');

  DOM.partnerStatus.textContent = state.partnerOnline ? '在线' : '离线';
  DOM.partnerStatus.classList.toggle('offline', !state.partnerOnline);
  DOM.partnerAvatar.textContent = state.partnerOnline ? '🟢' : '👤';
  DOM.partnerName.textContent = '已绑定设备';
}

function switchToUnpairedView() {
  DOM.pairedView.classList.remove('active');
  DOM.unpairedView.classList.add('active');
  DOM.bottomNav.classList.add('hidden');
  DOM.pairingCodeDisplay.classList.add('hidden');
  DOM.codeNumber.textContent = '------';
  DOM.inputPairingCode.value = '';
  DOM.joinError.classList.add('hidden');
  DOM.eventLog.innerHTML = '<p class="log-empty">暂无事件记录</p>';
  resetTapState();
}

// ============ 警报音效 ============
function playAlertSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // 创建警报音：高音调交替
    function playTone(freq, startTime, duration) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.3, startTime);
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
    }

    const now = audioCtx.currentTime;
    // 交替高低音
    for (let i = 0; i < 6; i++) {
      playTone(i % 2 === 0 ? 880 : 660, now + i * 0.15, 0.15);
    }
  } catch (e) {
    console.warn('无法播放警报音:', e);
  }
}

// ============ 事件绑定 ============
function setupEventListeners() {
  // 生成配对码
  DOM.btnGenerateCode.addEventListener('click', () => {
    if (!sendMessage('generate_code', {})) return;
    DOM.btnGenerateCode.textContent = '🔄 重新生成配对码';
  });

  // 复制配对码
  DOM.btnCopyCode.addEventListener('click', () => {
    if (state.pairingCode) {
      navigator.clipboard.writeText(state.pairingCode).then(() => {
        showToast('配对码已复制到剪贴板', 'success');
      }).catch(() => {
        showToast('复制失败，请手动记录', 'error');
      });
    }
  });

  // 加入配对
  DOM.btnJoinCode.addEventListener('click', () => {
    const code = DOM.inputPairingCode.value.trim();
    DOM.joinError.classList.add('hidden');

    if (!/^\d{6}$/.test(code)) {
      DOM.joinError.textContent = '请输入6位数字配对码';
      DOM.joinError.classList.remove('hidden');
      return;
    }

    sendMessage('join_code', { code });
  });

  // 输入框回车加入
  DOM.inputPairingCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      DOM.btnJoinCode.click();
    }
  });

  // 只允许输入数字
  DOM.inputPairingCode.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
  });

  // 解除配对
  DOM.btnUnpair.addEventListener('click', () => {
    if (confirm('确定要解除绑定吗？解除后需要重新配对。')) {
      sendMessage('unpair', {});
    }
  });

  // === 服务器设置 ===
  DOM.btnOpenSettings.addEventListener('click', () => {
    DOM.inputWsUrl.value = CONFIG.isCustomUrl ? CONFIG.WS_URL : '';
    DOM.inputWsUrl.placeholder = CONFIG.defaultUrl;
    DOM.settingsStatus.textContent = CONFIG.isCustomUrl
      ? `当前使用: ${CONFIG.WS_URL}`
      : `默认: ${CONFIG.defaultUrl}`;
    DOM.settingsOverlay.classList.remove('hidden');
  });

  DOM.btnCloseSettings.addEventListener('click', () => {
    DOM.settingsOverlay.classList.add('hidden');
  });

  DOM.btnSaveSettings.addEventListener('click', () => {
    const url = DOM.inputWsUrl.value.trim();
    if (!url) {
      DOM.settingsStatus.textContent = '请输入 WebSocket 地址或点"恢复默认"';
      return;
    }
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      DOM.settingsStatus.textContent = '地址必须以 ws:// 或 wss:// 开头';
      return;
    }
    CONFIG.WS_URL = url;
    DOM.settingsStatus.textContent = `✅ 已保存: ${url}，正在重连...`;
    DOM.settingsOverlay.classList.add('hidden');
    disconnectAndReconnect();
  });

  DOM.btnResetSettings.addEventListener('click', () => {
    CONFIG.WS_URL = ''; // 清除自定义，恢复默认
    DOM.settingsStatus.textContent = `✅ 已恢复默认: ${CONFIG.defaultUrl}，正在重连...`;
    DOM.settingsOverlay.classList.add('hidden');
    DOM.inputWsUrl.value = '';
    disconnectAndReconnect();
  });
}

/** 断开当前连接并用新地址重连 */
function disconnectAndReconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectAttempts = 0;
  if (state.ws) {
    state.ws.onclose = null; // 阻止自动重连
    state.ws.close();
    state.ws = null;
  }
  state.paired = false;
  state.partnerId = null;
  state.partnerOnline = false;
  switchToUnpairedView();
  updateConnectionStatus('connecting', '重连中...');
  setTimeout(() => connectWebSocket(), 500);
}

// ============ 初始化 ============
function init() {
  console.log('🚀 双击守护启动中...');

  // 注册 Service Worker (PWA)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => {
      console.log('[SW] Service Worker 已注册');
    }).catch((err) => {
      console.warn('[SW] 注册失败:', err);
    });
  }

  // 设置点击检测
  setupTapDetection();

  // 设置事件监听
  setupEventListeners();

  // 连接 WebSocket
  connectWebSocket();

  // 页面可见性变化时检查连接
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        connectWebSocket();
      } else if (state.paired) {
        // 恢复时查询状态
        sendMessage('status', {});
      }
    }
  });

  // 在线/离线事件
  window.addEventListener('online', () => {
    showToast('网络已恢复', 'success');
    connectWebSocket();
  });

  window.addEventListener('offline', () => {
    showToast('网络已断开', 'error');
    updateConnectionStatus('disconnected', '无网络');
  });

  console.log('✅ 初始化完成');
}

// 启动应用
document.addEventListener('DOMContentLoaded', init);
