// agent-qr-v4.js
// ✅ QR scanner fixes (proper char mapping, shift tracking, race-condition guard)
// ✅ Module ID hardcoded to '09' — no WS handshake needed
// ✅ Timing optimised from guest-only agent (beltToStepper, stepperReset, etc.)
// ✅ Stepper home fire-and-forget (overlaps with next detection)
// ✅ Reduced photoDelay / weightDelay / photoPositionDelay
// ✅ Bin status published with retain + qos:1
// ✅ machine-config.json for deviceId

const mqtt   = require('mqtt');
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const WebSocket = require('ws');
const HID = require('node-hid');

// QR Scanner device (USBKey Module)
const QR_VENDOR_ID  = 1317;
const QR_PRODUCT_ID = 42156;

// ============================================
// LOAD MACHINE CONFIG
// ============================================
const machineConfigPath = path.join('C:\\Users\\YY', 'machine-config.json');

if (!fs.existsSync(machineConfigPath)) {
  console.error(`❌ Config file not found: ${machineConfigPath}`);
  console.error('Please create machine-config.json with: { "deviceId": "RVM-XXXX" }');
  process.exit(1);
}

const machineConfig = JSON.parse(fs.readFileSync(machineConfigPath, 'utf8'));
const DEVICE_ID = machineConfig.deviceId;

if (!DEVICE_ID) {
  console.error('❌ deviceId not found in machine-config.json');
  process.exit(1);
}

console.log(`✅ Device ID loaded: ${DEVICE_ID}`);

// ============================================
// HARDCODED MODULE ID
// ============================================
const HARDCODED_MODULE_ID = '09';

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  device: {
    id: DEVICE_ID
  },

  backend: {
    url: 'https://app.rebit-japan.com/',
    timeout: 8000
  },

  local: {
    baseUrl: 'http://localhost:8081',
    wsUrl:   'ws://localhost:8081/websocket/qazwsx1234',
    timeout: 8000
  },

  mqtt: {
    brokerUrl: 'mqtts://app.rebit-japan.com:8883',
    username:  'mqttproduser',
    password:  '2o25@pR0Du$3rW8tl',
    caFile:    'C:\\Users\\YY\\RebitMqtt\\certs/app.rebit-japan.com.ca-bundle',
    topics: {
      commands:      `rvm/${DEVICE_ID}/commands`,
      autoControl:   `rvm/${DEVICE_ID}/control/auto`,
      cycleComplete: `rvm/${DEVICE_ID}/cycle/complete`,
      aiResult:      `rvm/${DEVICE_ID}/ai/result`,
      weightResult:  `rvm/${DEVICE_ID}/weight/result`,
      status:        `rvm/${DEVICE_ID}/status`,
      qrScan:        `rvm/${DEVICE_ID}/qr/scanned`,
      screenState:   `rvm/${DEVICE_ID}/screen/state`,
      qrInput:       `rvm/${DEVICE_ID}/qr/input`,
      guestStart:    `rvm/${DEVICE_ID}/guest/start`,
      binStatus:     `rvm/${DEVICE_ID}/bin/status`
    }
  },

  qr: {
    enabled:            true,
    minLength:          5,
    maxLength:          50,
    scanTimeout:        200,
    processingTimeout:  25000,
    debug:              true,
    restartAfterSession: true,
    healthCheckInterval: 15000
  },

  motors: {
    belt: {
      toWeight: { motorId: "02", type: "02" },
      toStepper: { motorId: "02", type: "03" },
      reverse:   { motorId: "02", type: "01" },
      stop:      { motorId: "02", type: "00" }
    },
    compactor: {
      start: { motorId: "04", type: "01" },
      stop:  { motorId: "04", type: "00" }
    },
    stepper: {
      moduleId:  '09',
      positions: { home: '01', metalCan: '02', plasticBottle: '03' }
    }
  },

  detection: {
    METAL_CAN:           0.65,
    PLASTIC_BOTTLE:      0.65,
    GLASS:               0.65,
    retryDelay:          1500,
    maxRetries:          2,
    hasObjectSensor:     false,
    minConfidenceRetry:  0.50,
    minValidWeight:      2,
    positionBeforePhoto: true
  },

  // ⚡ Optimised timings (merged from guest-only agent)
  timing: {
    beltToWeight:       1800,   // ⚡ was 2500
    beltToStepper:      1800,   // ⚡ was 2800 — same distance as beltToWeight
    beltReverse:        3500,   // ⚡ was 4000
    stepperRotate:      2200,   // ⚡ was 2500
    stepperReset:       2200,   // ⚡ was 3500 — same motor, same distance
    compactorCycle:     22000,
    compactorIdleStop:  20000,  // ⚡ was 8000 — give more idle time
    positionSettle:     100,    // ⚡ was 300
    gateOperation:      600,    // ⚡ was 800
    autoPhotoDelay:     500,    // ⚡ was 2500 — loop interval (weight check guards entry)
    sessionTimeout:     120000,
    sessionMaxDuration: 600000,
    weightDelay:        600,    // ⚡ was 1200
    photoDelay:         300,    // ⚡ was 1000
    calibrationDelay:   800,    // ⚡ was 1000
    commandDelay:       100,
    resetHomeDelay:     1000,   // ⚡ was 1200
    itemDropDelay:      300,    // ⚡ was 800
    photoPositionDelay: 100     // ⚡ was 400
  },

  heartbeat: {
    interval:           30,
    maxModuleIdRetries: 10,
    stateCheckInterval: 30
  },

  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  }
};

// ============================================
// STATE
// ============================================
const state = {
  moduleId: HARDCODED_MODULE_ID,   // ✅ hardcoded — no WS handshake required
  aiResult:  null,
  weight:    null,
  autoCycleEnabled: false,
  cycleInProgress:  false,
  calibrationAttempts: 0,
  ws:      null,
  isReady: false,

  // QR scanner
  qrBuffer:           '',
  lastCharTime:       0,
  qrTimer:            null,
  processingQR:       false,
  processingQRTimeout: null,
  lastSuccessfulScan: null,
  lastKeyboardActivity: Date.now(),
  scannerHealthTimer: null,
  lastScannerRestart: Date.now(),
  hidDevice: null,

  // Session
  sessionId:        null,
  sessionCode:      null,
  currentUserId:    null,
  currentUserData:  null,
  isMember:         false,
  isGuestSession:   false,
  itemsProcessed:   0,
  sessionStartTime: null,
  lastActivityTime: null,
  sessionTimeoutTimer: null,
  maxDurationTimer:    null,
  sessionCount:        0,

  // Compactor
  compactorRunning: false,
  compactorTimer:   null,
  compactorIdleTimer: null,
  lastItemTime:     null,

  autoPhotoTimer:        null,
  detectionRetries:      0,
  awaitingDetection:     false,
  resetting:             false,
  itemAlreadyPositioned: false,

  binStatus: { plastic: false, metal: false, right: false, glass: false },

  lastCycleTime:    null,
  averageCycleTime: null,
  cycleCount:       0,

  detectionStats: {
    totalAttempts:       0,
    firstTimeSuccess:    0,
    secondTimeSuccess:   0,
    thirdTimeSuccess:    0,
    failures:            0,
    averageRetries:      0,
    lastSuccessfulTiming: null,
    positioningHelped:   0
  }
};

// ============================================
// UTILITIES
// ============================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = {
    info:      'ℹ️',
    success:   '✅',
    error:     '❌',
    warning:   '⚠️',
    debug:     '🔍',
    perf:      '⚡',
    qr:        '📱',
    crusher:   '🔨',
    camera:    '📸',
    detection: '🎯'
  }[level] || 'ℹ️';
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function debugLog(message) {
  if (CONFIG.qr.debug) log(message, 'debug');
}

function trackCycleTime(startTime) {
  const cycleTime = Date.now() - startTime;
  state.lastCycleTime = cycleTime;
  state.cycleCount++;
  if (state.averageCycleTime === null) {
    state.averageCycleTime = cycleTime;
  } else {
    state.averageCycleTime =
      (state.averageCycleTime * (state.cycleCount - 1) + cycleTime) / state.cycleCount;
  }
  log(`Cycle ${(cycleTime/1000).toFixed(1)}s | Avg ${(state.averageCycleTime/1000).toFixed(1)}s`, 'perf');
}

function trackDetectionAttempt(success, retryCount) {
  state.detectionStats.totalAttempts++;
  if (success) {
    if (retryCount === 0)      state.detectionStats.firstTimeSuccess++;
    else if (retryCount === 1) state.detectionStats.secondTimeSuccess++;
    else if (retryCount === 2) state.detectionStats.thirdTimeSuccess++;
    state.detectionStats.lastSuccessfulTiming = {
      retries:   retryCount,
      timestamp: new Date().toISOString()
    };
  } else {
    state.detectionStats.failures++;
  }
  const totalRetries =
    (state.detectionStats.secondTimeSuccess * 1) +
    (state.detectionStats.thirdTimeSuccess * 2);
  const successfulAttempts =
    state.detectionStats.firstTimeSuccess +
    state.detectionStats.secondTimeSuccess +
    state.detectionStats.thirdTimeSuccess;
  if (successfulAttempts > 0) {
    state.detectionStats.averageRetries = totalRetries / successfulAttempts;
  }
  if (state.detectionStats.totalAttempts % 10 === 0) logDetectionStats();
}

function logDetectionStats() {
  const s = state.detectionStats;
  const total = s.firstTimeSuccess + s.secondTimeSuccess + s.thirdTimeSuccess + s.failures;
  if (total === 0) return;
  const r1 = ((s.firstTimeSuccess / total) * 100).toFixed(1);
  log(`📊 Detection: ${s.totalAttempts} total | ${r1}% first-time | Avg retries: ${s.averageRetries.toFixed(2)}`, 'detection');
}

// ============================================
// QR SCANNER — node-hid direct (no WinKeyServer.exe)
// ============================================

// USB HID scan-code → character maps
const HID_KEY_MAP = {
  0x04:'a',0x05:'b',0x06:'c',0x07:'d',0x08:'e',0x09:'f',
  0x0A:'g',0x0B:'h',0x0C:'i',0x0D:'j',0x0E:'k',0x0F:'l',
  0x10:'m',0x11:'n',0x12:'o',0x13:'p',0x14:'q',0x15:'r',
  0x16:'s',0x17:'t',0x18:'u',0x19:'v',0x1A:'w',0x1B:'x',
  0x1C:'y',0x1D:'z',
  0x1E:'1',0x1F:'2',0x20:'3',0x21:'4',0x22:'5',
  0x23:'6',0x24:'7',0x25:'8',0x26:'9',0x27:'0',
  0x28:'\n',0x2C:' ',0x2D:'-',0x2E:'=',0x2F:'[',
  0x30:']',0x31:'\\',0x33:';',0x34:"'",0x35:'`',
  0x36:',',0x37:'.',0x38:'/',
  0x59:'1',0x5A:'2',0x5B:'3',0x5C:'4',0x5D:'5',
  0x5E:'6',0x5F:'7',0x60:'8',0x61:'9',0x62:'0',
  0x63:'.',0x56:'-',0x57:'+',0x55:'*',0x54:'/'
};
const HID_SHIFT_MAP = {
  0x04:'A',0x05:'B',0x06:'C',0x07:'D',0x08:'E',0x09:'F',
  0x0A:'G',0x0B:'H',0x0C:'I',0x0D:'J',0x0E:'K',0x0F:'L',
  0x10:'M',0x11:'N',0x12:'O',0x13:'P',0x14:'Q',0x15:'R',
  0x16:'S',0x17:'T',0x18:'U',0x19:'V',0x1A:'W',0x1B:'X',
  0x1C:'Y',0x1D:'Z',
  0x1E:'!',0x1F:'@',0x20:'#',0x21:'$',0x22:'%',
  0x23:'^',0x24:'&',0x25:'*',0x26:'(',0x27:')',
  0x2D:'_',0x2E:'+',0x2F:'{',0x30:'}',0x31:'|',
  0x33:':',0x34:'"',0x35:'~',0x36:'<',0x37:'>',0x38:'?'
};

function canAcceptQRScan() {
  return state.isReady &&
    !state.autoCycleEnabled &&
    !state.processingQR &&
    !state.resetting;
}

function clearQRProcessing() {
  if (state.processingQRTimeout) {
    clearTimeout(state.processingQRTimeout);
    state.processingQRTimeout = null;
  }
  if (state.qrTimer) {
    clearTimeout(state.qrTimer);
    state.qrTimer = null;
  }
  state.processingQR = false;
  state.qrBuffer     = '';
  debugLog('QR processing state cleared');
}

function forceRestartScanner() {
  log('Restarting HID QR scanner...', 'warning');
  clearQRProcessing();
  if (state.hidDevice) {
    try { state.hidDevice.close(); } catch (_) {}
    state.hidDevice = null;
  }
  setTimeout(() => setupQRScanner(), 1000);
}

function startScannerHealthMonitor() {
  if (state.scannerHealthTimer) clearInterval(state.scannerHealthTimer);
  state.scannerHealthTimer = setInterval(() => {
    if (!state.hidDevice && canAcceptQRScan()) {
      log('Auto-healing HID scanner...', 'warning');
      setupQRScanner();
    }
  }, CONFIG.qr.healthCheckInterval);
}

async function validateQRWithBackend(sessionCode) {
  try {
    const response = await axios.post(
      `${CONFIG.backend.url}/api/rvm/${CONFIG.device.id}/qr/validate`,
      { sessionCode },
      { timeout: CONFIG.backend.timeout, headers: { 'Content-Type': 'application/json' } }
    );
    if (response.data.success) {
      log(`QR validated — User: ${response.data.user.name}`, 'success');
      return { valid: true, user: response.data.user, session: response.data.session };
    }
    return { valid: false, error: response.data.error || 'Invalid QR code' };
  } catch (error) {
    log(`QR validation error: ${error.message}`, 'error');
    return { valid: false, error: error.response?.data?.error || 'Network error' };
  }
}

async function processQRCode(qrData) {
  if (!canAcceptQRScan()) {
    debugLog('QR rejected — system not ready');
    return;
  }

  const cleanCode = qrData.replace(/[\r\n\t]/g, '').trim();
  if (cleanCode.length < CONFIG.qr.minLength || cleanCode.length > CONFIG.qr.maxLength) {
    log(`Invalid QR length: ${cleanCode.length}`, 'error');
    return;
  }

  // Mark busy BEFORE any await — prevents double-processing
  state.processingQR = true;
  state.processingQRTimeout = setTimeout(() => {
    log('QR processing timeout!', 'warning');
    clearQRProcessing();
  }, CONFIG.qr.processingTimeout);

  log(`QR CODE: ${cleanCode}`, 'qr');

  let sessionStarted = false;

  try {
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId:  CONFIG.device.id,
      state:     'qr_validating',
      message:   'Validating...',
      timestamp: new Date().toISOString()
    }));

    const validation = await validateQRWithBackend(cleanCode);

    if (validation.valid) {
      state.lastSuccessfulScan = new Date().toISOString();

      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId:  CONFIG.device.id,
        state:     'qr_validated',
        message:   `Welcome ${validation.user.name}!`,
        user:      validation.user,
        timestamp: new Date().toISOString()
      }));

      await delay(1500);

      // Clear BEFORE handing off — startMemberSession sets isReady=false immediately
      clearQRProcessing();
      sessionStarted = true;
      await startMemberSession(validation);

    } else {
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId:  CONFIG.device.id,
        state:     'qr_invalid',
        message:   validation.error,
        timestamp: new Date().toISOString()
      }));
      await delay(2500);
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId:  CONFIG.device.id,
        state:     'ready_for_qr',
        message:   'Please scan your QR code',
        timestamp: new Date().toISOString()
      }));
    }

  } catch (error) {
    log(`QR error: ${error.message}`, 'error');
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId:  CONFIG.device.id,
      state:     'error',
      message:   'Error — please try again',
      timestamp: new Date().toISOString()
    }));
    await delay(2500);

  } finally {
    if (!sessionStarted) clearQRProcessing();
    log('QR processing complete', 'qr');
  }
}

function setupQRScanner() {
  if (!CONFIG.qr.enabled) { log('QR scanner disabled', 'warning'); return; }

  if (state.hidDevice) {
    try { state.hidDevice.close(); } catch (_) {}
    state.hidDevice = null;
  }

  log('Opening HID QR scanner...', 'qr');

  let device;
  try {
    device = new HID.HID(QR_VENDOR_ID, QR_PRODUCT_ID);
  } catch (err) {
    log(`HID open failed: ${err.message}`, 'error');
    log('Retrying in 3s...', 'warning');
    setTimeout(() => setupQRScanner(), 3000);
    return;
  }

  state.hidDevice = device;
  state.lastScannerRestart   = Date.now();
  state.lastKeyboardActivity = Date.now();

  device.on('data', (data) => {
    state.lastKeyboardActivity = Date.now();
    if (!canAcceptQRScan()) return;

    const modifier  = data[0];
    const shiftDown = (modifier & 0x02) || (modifier & 0x20);

    for (let i = 2; i < 8; i++) {
      const keyCode = data[i];
      if (!keyCode) continue;

      if (keyCode === 0x28) {
        if (
          state.qrBuffer.length >= CONFIG.qr.minLength &&
          state.qrBuffer.length <= CONFIG.qr.maxLength
        ) {
          const qrCode = state.qrBuffer;
          state.qrBuffer = '';
          if (state.qrTimer) { clearTimeout(state.qrTimer); state.qrTimer = null; }
          log(`QR detected: ${qrCode}`, 'success');
          processQRCode(qrCode).catch(err => {
            log(`QR async error: ${err.message}`, 'error');
            clearQRProcessing();
          });
        } else {
          state.qrBuffer = '';
        }
        return;
      }

      const char = shiftDown
        ? (HID_SHIFT_MAP[keyCode] || HID_KEY_MAP[keyCode] || null)
        : (HID_KEY_MAP[keyCode] || null);
      if (!char || char === '\n') continue;

      const currentTime = Date.now();
      if ((currentTime - state.lastCharTime) > CONFIG.qr.scanTimeout && state.qrBuffer.length > 0) {
        state.qrBuffer = '';
      }
      if (state.qrBuffer.length >= CONFIG.qr.maxLength) {
        state.qrBuffer = '';
        if (state.qrTimer) { clearTimeout(state.qrTimer); state.qrTimer = null; }
        continue;
      }

      state.qrBuffer    += char;
      state.lastCharTime = currentTime;
      debugLog(`Buffer: "${state.qrBuffer}"`);

      if (state.qrTimer) clearTimeout(state.qrTimer);
      state.qrTimer = setTimeout(() => {
        state.qrTimer = null;
        if (
          state.qrBuffer.length >= CONFIG.qr.minLength &&
          state.qrBuffer.length <= CONFIG.qr.maxLength
        ) {
          const qrCode = state.qrBuffer;
          state.qrBuffer = '';
          log(`QR auto-detected: ${qrCode}`, 'success');
          processQRCode(qrCode).catch(err => {
            log(`QR async error: ${err.message}`, 'error');
            clearQRProcessing();
          });
        } else {
          state.qrBuffer = '';
        }
      }, CONFIG.qr.scanTimeout);
    }
  });

  device.on('error', (err) => {
    log(`HID error: ${err.message}`, 'error');
    state.hidDevice = null;
    setTimeout(() => { if (canAcceptQRScan()) setupQRScanner(); }, 3000);
  });

  log(`QR scanner ready (HID ${QR_VENDOR_ID}:${QR_PRODUCT_ID})`, 'success');
}


// ============================================
// COMPACTOR
// ============================================
async function startContinuousCompactor() {
  if (state.compactorIdleTimer) { clearTimeout(state.compactorIdleTimer); state.compactorIdleTimer = null; }

  if (state.compactorRunning) { resetCompactorIdleTimer(); return; }

  try {
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    state.compactorRunning = true;
    state.lastItemTime = Date.now();
    log('Compactor started', 'crusher');
    resetCompactorIdleTimer();
  } catch (error) {
    log(`Failed to start compactor: ${error.message}`, 'error');
    state.compactorRunning = false;
    throw error;
  }
}

function resetCompactorIdleTimer() {
  if (state.compactorIdleTimer) clearTimeout(state.compactorIdleTimer);
  state.lastItemTime = Date.now();
  state.compactorIdleTimer = setTimeout(async () => {
    if (state.compactorRunning && state.autoCycleEnabled) {
      log('No items — stopping compactor (idle)', 'crusher');
      await stopCompactor();
    }
  }, CONFIG.timing.compactorIdleStop);
}

async function stopCompactor() {
  if (!state.compactorRunning) return;
  try {
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    log('Compactor stopped', 'crusher');
  } catch (error) {
    log(`Compactor stop error: ${error.message}`, 'error');
  }
  state.compactorRunning = false;
  if (state.compactorTimer)   { clearTimeout(state.compactorTimer);   state.compactorTimer   = null; }
  if (state.compactorIdleTimer) { clearTimeout(state.compactorIdleTimer); state.compactorIdleTimer = null; }
}

// ============================================
// PHOTO DETECTION (OPTIMISED)
// ============================================
async function scheduleNextPhotoWithPositioning() {
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);

  state.autoPhotoTimer = setTimeout(async () => {
    if (!state.autoCycleEnabled || state.cycleInProgress || state.awaitingDetection) return;

    // Pre-stop belt, then weight-check for item presence
    try {
      await executeCommand('customMotor', CONFIG.motors.belt.stop);
      await delay(CONFIG.timing.positionSettle);
    } catch (e) { /* non-fatal */ }

    try {
      await executeCommand('getWeight');
      // weightDelay is already baked into executeCommand for getWeight,
      // but WS response (function '06') may arrive slightly after — add a small buffer
      await delay(200);

      if (!state.weight || state.weight.weight < CONFIG.detection.minValidWeight) {
        log(`No item (weight: ${state.weight ? state.weight.weight + 'g' : 'null'}) — waiting`, 'debug');
        state.weight = null;
        if (state.autoCycleEnabled) scheduleNextPhotoWithPositioning();
        return;
      }

      log(`Item detected (${state.weight.weight}g) — positioning`, 'success');
      state.weight = null;

    } catch (error) {
      log(`Weight check error: ${error.message}`, 'error');
      if (state.autoCycleEnabled) scheduleNextPhotoWithPositioning();
      return;
    }

    state.awaitingDetection    = true;
    state.itemAlreadyPositioned = false;

    try {
      if (CONFIG.detection.positionBeforePhoto) {
        log('[1] Moving belt to camera position...', 'camera');
        await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
        await delay(CONFIG.timing.beltToWeight);
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        await delay(CONFIG.timing.photoPositionDelay);
        state.itemAlreadyPositioned = true;
        log('[2] Item at camera position', 'camera');
      }

      log('[3] Taking photo...', 'camera');
      await executeCommand('takePhoto');
      log('Photo sent — awaiting AI result', 'camera');

    } catch (error) {
      log(`Photo/positioning error: ${error.message}`, 'error');
      state.awaitingDetection    = false;
      state.itemAlreadyPositioned = false;
      state.weight = null;
      try { await executeCommand('customMotor', CONFIG.motors.belt.stop); } catch (_) { /* ignore */ }
      if (state.autoCycleEnabled) scheduleNextPhotoWithPositioning();
    }

  }, CONFIG.timing.autoPhotoDelay);
}

// ============================================
// HEARTBEAT
// ============================================
const heartbeat = {
  interval:          null,
  stateCheckInterval: null,
  timeout:           CONFIG.heartbeat.interval,
  moduleIdRetries:   0,
  maxModuleIdRetries: CONFIG.heartbeat.maxModuleIdRetries,

  start() {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this.beat(), this.timeout * 1000);

    if (this.stateCheckInterval) clearInterval(this.stateCheckInterval);
    this.stateCheckInterval = setInterval(
      () => checkScannerHealth(),
      CONFIG.heartbeat.stateCheckInterval * 1000
    );

    log(`Heartbeat: ${this.timeout}s`, 'info');
    startScannerHealthMonitor();
  },

  stop() {
    if (this.interval)           { clearInterval(this.interval);           this.interval = null; }
    if (this.stateCheckInterval) { clearInterval(this.stateCheckInterval); this.stateCheckInterval = null; }
    if (state.scannerHealthTimer){ clearInterval(state.scannerHealthTimer); state.scannerHealthTimer = null; }
  },

  async beat() {
    const timestamp = new Date().toISOString();

    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) connectWebSocket();

    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId:              CONFIG.device.id,
      status:                state.isReady ? 'ready' : 'initializing',
      event:                 'heartbeat',
      moduleId:              state.moduleId,
      isReady:               state.isReady,
      autoCycleEnabled:      state.autoCycleEnabled,
      canAcceptQRScan:       canAcceptQRScan(),
      processingQR:          state.processingQR,
      hidDeviceActive: state.hidDevice !== null,
      compactorRunning:      state.compactorRunning,
      lastCycleTime:         state.lastCycleTime,
      detectionStats:        state.detectionStats,
      timestamp
    }));

    const scanStatus      = canAcceptQRScan() ? '🟢 READY' : '🔴 BUSY';
    const compactorStatus = state.compactorRunning ? '🔨' : '⚪';
    const perfInfo        = state.lastCycleTime ? ` | ${(state.lastCycleTime/1000).toFixed(1)}s` : '';

    console.log(`💓 ${state.isReady ? '🟢' : '🟡'} | ${state.moduleId} | ${state.autoCycleEnabled ? 'SESSION' : 'IDLE'} | ${scanStatus} | ${compactorStatus}${perfInfo}`);
  }
};

// ============================================
// DIAGNOSTICS
// ============================================
function runDiagnostics() {
  console.log('\n' + '='.repeat(60));
  console.log('🔬 SYSTEM DIAGNOSTICS');
  console.log('='.repeat(60));
  console.log(`\n   deviceId:  ${CONFIG.device.id}`);
  console.log(`   moduleId:  ${state.moduleId} (HARDCODED)`);
  console.log(`   isReady:   ${state.isReady}`);
  console.log(`   autoCycle: ${state.autoCycleEnabled}`);
  console.log(`   resetting: ${state.resetting}`);
  console.log(`   cycleInProgress: ${state.cycleInProgress}`);
  console.log('\n📱 QR Scanner:');
  console.log(`   listener:   ${state.globalKeyListener ? '✅' : '❌'}`);
  console.log(`   processing: ${state.processingQR}`);
  console.log(`   canScan:    ${canAcceptQRScan()}`);
  console.log(`   buffer:     "${state.qrBuffer}"`);
  console.log('\n🔨 Compactor:');
  console.log(`   running:    ${state.compactorRunning}`);
  console.log(`   idleTimer:  ${state.compactorIdleTimer ? 'ACTIVE' : 'NONE'}`);
  console.log('\n🗑️  Bins:');
  console.log(`   plastic: ${state.binStatus.plastic ? '❌ FULL' : '✅ OK'}`);
  console.log(`   metal:   ${state.binStatus.metal   ? '❌ FULL' : '✅ OK'}`);
  console.log(`   right:   ${state.binStatus.right   ? '❌ FULL' : '✅ OK'}`);
  console.log(`   glass:   ${state.binStatus.glass   ? '❌ FULL' : '✅ OK'}`);
  console.log('\n' + '='.repeat(60) + '\n');
  logDetectionStats();
}

// ============================================
// MATERIAL DETECTION
// ============================================
function determineMaterialType(aiData) {
  const className   = (aiData.className || '').toLowerCase().trim();
  const probability = aiData.probability || 0;

  let materialType   = 'UNKNOWN';
  let threshold      = 1.0;
  let hasStrongKeyword = false;
  let detectionFormat  = 'unknown';

  if (className === '0-pet' || className.startsWith('0-pet')) {
    materialType = 'PLASTIC_BOTTLE'; threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = true; detectionFormat = 'new_standard';
  } else if (className === '1-can' || className.startsWith('1-can')) {
    materialType = 'METAL_CAN'; threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = true; detectionFormat = 'new_standard';
  } else if (/^0[-_\s]*(pet|plastic|bottle)/i.test(className)) {
    materialType = 'PLASTIC_BOTTLE'; threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = true; detectionFormat = 'variant_format';
  } else if (/^1[-_\s]*(can|metal|aluminum)/i.test(className)) {
    materialType = 'METAL_CAN'; threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = true; detectionFormat = 'variant_format';
  } else if (className.includes('易拉罐') || className.includes('铝')) {
    materialType = 'METAL_CAN'; threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = true; detectionFormat = 'legacy_chinese';
  } else if (className.includes('pet') || className.includes('瓶')) {
    materialType = 'PLASTIC_BOTTLE'; threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = className.includes('pet'); detectionFormat = 'legacy_keyword';
  } else if (className.includes('metal') || className.includes('can')) {
    materialType = 'METAL_CAN'; threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = false; detectionFormat = 'legacy_keyword';
  } else if (className.includes('plastic') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE'; threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = false; detectionFormat = 'legacy_keyword';
  } else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS'; threshold = CONFIG.detection.GLASS;
    hasStrongKeyword = className.includes('玻璃'); detectionFormat = 'glass_detected';
  }

  const pct = Math.round(probability * 100);

  if (probability < CONFIG.detection.minConfidenceRetry && materialType === 'UNKNOWN') return 'UNKNOWN';

  if (materialType !== 'UNKNOWN' && probability < threshold) {
    const relaxed = detectionFormat === 'new_standard' ? threshold * 0.70 : threshold * 0.80;
    if (hasStrongKeyword && probability >= relaxed) {
      log(`${materialType} (${pct}% keyword)`, 'detection'); return materialType;
    }
    if (detectionFormat === 'new_standard' && probability >= 0.45) {
      log(`${materialType} (${pct}% standard)`, 'detection'); return materialType;
    }
    log(`Low confidence ${pct}% — UNKNOWN`, 'warning'); return 'UNKNOWN';
  }

  if (materialType !== 'UNKNOWN') log(`${materialType} (${pct}%)`, 'detection');
  return materialType;
}

// ============================================
// HARDWARE CONTROL
// ============================================
async function executeCommand(action, params = {}) {
  const deviceType = 1;
  let apiUrl, apiPayload;

  switch (action) {
    case 'openGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '03', deviceType };
      log('Opening gate...', 'info'); break;
    case 'closeGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '01', deviceType };
      log('Closing gate...', 'info'); break;
    case 'getWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/getWeight`;
      apiPayload = { moduleId: state.moduleId, type: '00' }; break;
    case 'calibrateWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/weightCalibration`;
      apiPayload = { moduleId: state.moduleId, type: '00' }; break;
    case 'takePhoto':
      apiUrl = `${CONFIG.local.baseUrl}/system/camera/process`;
      apiPayload = {}; break;
    case 'stepperMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/stepMotorSelect`;
      apiPayload = { moduleId: CONFIG.motors.stepper.moduleId, id: params.position, type: params.position, deviceType }; break;
    case 'customMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: params.motorId, type: params.type, deviceType }; break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }

  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
    if (action === 'takePhoto') await delay(CONFIG.timing.photoDelay);
    if (action === 'getWeight') await delay(CONFIG.timing.weightDelay);
  } catch (error) {
    log(`${action} failed: ${error.message}`, 'error');
    throw error;
  }
}

// ============================================
// REJECTION CYCLE
// ============================================
async function executeRejectionCycle() {
  log('Rejecting item — reversing belt', 'warning');
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    trackDetectionAttempt(false, state.detectionRetries);
    mqttClient.publish(`rvm/${DEVICE_ID}/item/rejected`, JSON.stringify({
      deviceId:    CONFIG.device.id,
      reason:      'LOW_CONFIDENCE',
      userId:      state.currentUserId,
      sessionCode: state.sessionCode,
      retries:     state.detectionRetries,
      timestamp:   new Date().toISOString()
    }));
  } catch (error) {
    log(`Rejection error: ${error.message}`, 'error');
  }
  state.aiResult = null; state.weight = null;
  state.detectionRetries = 0; state.awaitingDetection = false;
  state.cycleInProgress  = false; state.itemAlreadyPositioned = false;
  if (state.autoCycleEnabled) await scheduleNextPhotoWithPositioning();
}

// ============================================
// AUTO CYCLE (OPTIMISED)
// ============================================
async function executeAutoCycle() {
  if (!state.aiResult || !state.weight) { state.cycleInProgress = false; return; }

  const cycleStartTime = Date.now();
  state.itemsProcessed++;
  trackDetectionAttempt(true, state.detectionRetries);
  if (state.itemAlreadyPositioned && state.detectionRetries > 0) state.detectionStats.positioningHelped++;

  const cycleData = {
    deviceId:         CONFIG.device.id,
    material:         state.aiResult.materialType,
    weight:           state.weight.weight,
    userId:           state.currentUserId,
    sessionCode:      state.sessionCode,
    itemNumber:       state.itemsProcessed,
    detectionRetries: state.detectionRetries,
    itemWasPositioned: state.itemAlreadyPositioned,
    timestamp:        new Date().toISOString()
  };

  log(`Item #${state.itemsProcessed}: ${cycleData.material} (${cycleData.weight}g)`, 'success');

  // Publish immediately — don't wait for motors
  mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));

  try {
    // ⚡ Fire-and-forget compactor — it's independent of belt/stepper
    startContinuousCompactor().catch(err => log(`Compactor bg error: ${err.message}`, 'error'));

    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    const targetPosition = cycleData.material === 'METAL_CAN'
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;

    await executeCommand('stepperMotor', { position: targetPosition });
    await delay(CONFIG.timing.stepperRotate);
    await delay(CONFIG.timing.itemDropDelay);

    resetCompactorIdleTimer();

    // ⚡ Fire stepper-home without awaiting — overlaps with next detection
    executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home })
      .catch(err => log(`Stepper home error: ${err.message}`, 'error'));

    await delay(200); // small buffer so command registers before releasing cycle lock

    trackCycleTime(cycleStartTime);
    resetInactivityTimer();

  } catch (error) {
    log(`Cycle error: ${error.message}`, 'error');
  }

  state.aiResult = null; state.weight = null;
  state.cycleInProgress = false; state.detectionRetries = 0;
  state.awaitingDetection = false; state.itemAlreadyPositioned = false;

  if (state.autoCycleEnabled) await scheduleNextPhotoWithPositioning();
}

// ============================================
// SESSION MANAGEMENT
// ============================================
async function startMemberSession(validationData) {
  state.sessionCount++;
  console.log('\n' + '='.repeat(50));
  console.log(`🎬 MEMBER SESSION #${state.sessionCount}`);
  console.log('='.repeat(50));

  try {
    state.isReady = false;
    state.currentUserId  = validationData.user.id;
    state.sessionId      = validationData.session.sessionId;
    state.sessionCode    = validationData.session.sessionCode;
    state.currentUserData = { name: validationData.user.name, email: validationData.user.email, currentPoints: validationData.user.currentPoints };
    state.isMember      = true;
    state.isGuestSession = false;
    state.autoCycleEnabled = true;
    state.itemsProcessed   = 0;
    state.sessionStartTime = new Date();
    startSessionTimers();

    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await stopCompactor();
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.resetHomeDelay);
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationDelay);
    await executeCommand('openGate');
    await delay(CONFIG.timing.commandDelay);

    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state:    'session_active',
      message:  'Insert your items',
      user:     { name: validationData.user.name, currentPoints: validationData.user.currentPoints },
      timestamp: new Date().toISOString()
    }));

    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId:    CONFIG.device.id,
      status:      'session_active',
      event:       'session_started',
      sessionType: 'member',
      userId:      state.currentUserId,
      sessionId:   state.sessionId,
      sessionCode: state.sessionCode,
      timestamp:   new Date().toISOString()
    }));

    log('Waiting 4s for first item...', 'info');
    await delay(4000);
    await scheduleNextPhotoWithPositioning();
    log('Member session active', 'success');

  } catch (error) {
    log(`Session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function startGuestSession(sessionData) {
  state.sessionCount++;
  console.log('\n' + '='.repeat(50));
  console.log(`🎬 GUEST SESSION #${state.sessionCount}`);
  console.log('='.repeat(50));

  try {
    state.isReady        = false;
    state.sessionId      = sessionData.sessionId;
    state.sessionCode    = sessionData.sessionCode;
    state.currentUserId  = null;
    state.currentUserData = null;
    state.isMember       = false;
    state.isGuestSession = true;
    state.autoCycleEnabled = true;
    state.itemsProcessed   = 0;
    state.sessionStartTime = new Date();
    startSessionTimers();

    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    await stopCompactor();
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.resetHomeDelay);
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationDelay);
    await executeCommand('openGate');
    await delay(CONFIG.timing.commandDelay);

    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId:    CONFIG.device.id,
      state:       'session_active',
      message:     'Insert your items',
      sessionType: 'guest',
      timestamp:   new Date().toISOString()
    }));

    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId:    CONFIG.device.id,
      status:      'session_active',
      event:       'session_started',
      sessionType: 'guest',
      sessionId:   state.sessionId,
      sessionCode: state.sessionCode,
      timestamp:   new Date().toISOString()
    }));

    log('Waiting 4s for first item...', 'info');
    await delay(4000);
    await scheduleNextPhotoWithPositioning();
    log('Guest session active', 'success');

  } catch (error) {
    log(`Session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function resetSystemForNextUser(forceStop = false) {
  const resetStart = Date.now();
  if (state.resetting) return;
  state.resetting = true;

  console.log('\n' + '='.repeat(50));
  console.log(`🔄 RESET AFTER SESSION #${state.sessionCount}`);
  console.log('='.repeat(50) + '\n');

  // Close gate immediately — first thing
  for (let i = 0; i < 2; i++) {
    try { await executeCommand('closeGate'); await delay(400); } catch (_) { /* ignore */ }
  }

  try {
    state.autoCycleEnabled = false;
    state.awaitingDetection = false;

    if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }

    if (state.cycleInProgress) {
      const startWait = Date.now();
      while (state.cycleInProgress && (Date.now() - startWait) < 60000) await delay(2000);
    }

    if (forceStop) {
      await stopCompactor();
    } else {
      if (state.compactorRunning) { await delay(2000); await stopCompactor(); }
    }

    await executeCommand('customMotor', CONFIG.motors.belt.stop);

  } catch (error) {
    log(`Reset error: ${error.message}`, 'error');
  } finally {
    // Notify backend of session end
    try {
      if (state.sessionCode) {
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId:       CONFIG.device.id,
          status:         'session_ended',
          event:          'session_ended',
          sessionCode:    state.sessionCode,
          itemsProcessed: state.itemsProcessed,
          sessionType:    state.isMember ? 'member' : 'guest',
          timestamp:      new Date().toISOString()
        }));
        await delay(1500);
      }
    } catch (_) { /* ignore */ }

    state.aiResult = null; state.weight = null;
    state.currentUserId = null; state.currentUserData = null;
    state.sessionId = null; state.sessionCode = null;
    state.calibrationAttempts = 0; state.cycleInProgress = false;
    state.itemsProcessed = 0; state.sessionStartTime = null;
    state.detectionRetries = 0; state.isMember = false;
    state.isGuestSession = false; state.lastItemTime = null;
    state.itemAlreadyPositioned = false;

    clearSessionTimers();
    clearQRProcessing();

    state.resetting = false;
    state.isReady   = true;

    // HID scanner reconnects automatically after session
    if (CONFIG.qr.restartAfterSession && !state.hidDevice) {
      setTimeout(() => setupQRScanner(), 1500);
    }

    console.log('='.repeat(50));
    console.log('✅ READY FOR NEXT USER');
    console.log('='.repeat(50) + '\n');

    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId:         CONFIG.device.id,
      status:           'ready',
      event:            'reset_complete',
      isReady:          true,
      autoCycleEnabled: false,
      timestamp:        new Date().toISOString()
    }));

    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId:  CONFIG.device.id,
      state:     'ready_for_qr',
      message:   'Please scan your QR code',
      timestamp: new Date().toISOString()
    }));

    log(`Reset done in ${Date.now() - resetStart}ms`, 'perf');
  }
}

// ============================================
// SESSION TIMERS
// ============================================
async function handleSessionTimeout(reason) {
  log(`Session timeout: ${reason}`, 'warning');

  for (let i = 0; i < 2; i++) {
    try { await executeCommand('closeGate'); await delay(400); } catch (_) { /* ignore */ }
  }

  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }

  try {
    if (state.sessionCode) {
      mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
        deviceId:       CONFIG.device.id,
        status:         'session_timeout',
        event:          'session_timeout',
        reason,
        sessionCode:    state.sessionCode,
        itemsProcessed: state.itemsProcessed,
        sessionType:    state.isMember ? 'member' : 'guest',
        timestamp:      new Date().toISOString()
      }));
      await delay(2000);
    }
  } catch (_) { /* ignore */ }

  if (state.cycleInProgress) {
    const startWait = Date.now();
    while (state.cycleInProgress && (Date.now() - startWait) < 60000) await delay(1000);
  }

  state.resetting = false;
  await resetSystemForNextUser(false);
}

function resetInactivityTimer() {
  if (state.sessionTimeoutTimer) clearTimeout(state.sessionTimeoutTimer);
  state.lastActivityTime   = Date.now();
  state.sessionTimeoutTimer = setTimeout(
    () => handleSessionTimeout('inactivity'),
    CONFIG.timing.sessionTimeout
  );
}

function startSessionTimers() {
  resetInactivityTimer();
  if (state.maxDurationTimer) clearTimeout(state.maxDurationTimer);
  state.maxDurationTimer = setTimeout(
    () => handleSessionTimeout('max_duration'),
    CONFIG.timing.sessionMaxDuration
  );
}

function clearSessionTimers() {
  if (state.sessionTimeoutTimer) { clearTimeout(state.sessionTimeoutTimer); state.sessionTimeoutTimer = null; }
  if (state.maxDurationTimer)    { clearTimeout(state.maxDurationTimer);    state.maxDurationTimer    = null; }
}

// ============================================
// WEBSOCKET
// ============================================
function connectWebSocket() {
  if (state.ws) {
    try { state.ws.removeAllListeners(); state.ws.close(); } catch (_) { /* ignore */ }
    state.ws = null;
  }

  state.ws = new WebSocket(CONFIG.local.wsUrl);

  state.ws.on('open', () => log('WebSocket connected', 'success'));

  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      // moduleId from WS — ignored (hardcoded)
      if (message.function === '01') {
        log(`WS moduleId: ${message.moduleId} (ignored — using hardcoded ${HARDCODED_MODULE_ID})`, 'debug');

        // First connect: mark ready and start scanner (same as before, minus the moduleId dependency)
        if (!state.isReady) {
          state.isReady = true;
          log('System ready (WS confirmed)');
          setupQRScanner();
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id, status: 'ready', moduleId: state.moduleId,
            isReady: true, timestamp: new Date().toISOString()
          }));
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id, state: 'ready_for_qr',
            message: 'Please scan your QR code', timestamp: new Date().toISOString()
          }));
        }
        return;
      }

      if (message.function === 'aiPhoto') {
        const aiData     = JSON.parse(message.data);
        const materialType = determineMaterialType(aiData);

        state.aiResult = {
          matchRate:    Math.round((aiData.probability || 0) * 100),
          materialType,
          className:    aiData.className,
          taskId:       aiData.taskId,
          timestamp:    new Date().toISOString()
        };

        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));

        if (state.autoCycleEnabled && state.awaitingDetection) {
          state.awaitingDetection = false;
          log('AI done — measuring weight', 'detection');
          setTimeout(() => executeCommand('getWeight'), 100); // ⚡ was 300ms
        }
        return;
      }

      if (message.function === 'deviceStatus') {
        const binCode = parseInt(message.data);
        const binStatusMap = {
          0: { name: 'Plastic (PET)', key: 'plastic', critical: true },
          1: { name: 'Metal Can',     key: 'metal',   critical: true },
          2: { name: 'Right Bin',     key: 'right',   critical: false },
          3: { name: 'Glass',         key: 'glass',   critical: false },
          4: { name: 'Infrared Sensor', key: null,    critical: false, isObjectSensor: true }
        };
        const binInfo = binStatusMap[binCode];
        if (binInfo) {
          if (binInfo.isObjectSensor) return;

          log(`${binInfo.name} bin full`, 'warning');
          if (binInfo.key) state.binStatus[binInfo.key] = true;

          // ✅ retain + qos:1 so backend always has latest state
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId:  CONFIG.device.id,
            binCode, binName: binInfo.name, binKey: binInfo.key,
            isFull: true, critical: binInfo.critical,
            binStatus: state.binStatus, timestamp: new Date().toISOString()
          }), { qos: 1, retain: true });

          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id,
            state:    'bin_full_warning',
            message:  `${binInfo.name} bin is full`,
            binCode,  timestamp: new Date().toISOString()
          }));

          if (binInfo.critical && state.autoCycleEnabled) {
            const currentBin = state.aiResult?.materialType === 'METAL_CAN' ? 'metal' : 'plastic';
            if (binInfo.key === currentBin) {
              setTimeout(() => handleSessionTimeout('bin_full'), 2000);
            }
          }
        }
        return;
      }

      if (message.function === '06') {
        const weightValue    = parseFloat(message.data) || 0;
        const coefficient    = CONFIG.weight.coefficients[1];
        const calibratedWeight = weightValue * (coefficient / 1000);

        state.weight = {
          weight:     Math.round(calibratedWeight * 10) / 10,
          rawWeight:  weightValue,
          coefficient,
          timestamp:  new Date().toISOString()
        };

        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));

        if (state.aiResult && state.autoCycleEnabled && !state.cycleInProgress) {
          log(`Weight: ${state.weight.weight}g`, 'info');

          if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
            state.calibrationAttempts++;
            setTimeout(async () => {
              await executeCommand('calibrateWeight');
              setTimeout(() => executeCommand('getWeight'), CONFIG.timing.calibrationDelay);
            }, 200);
            return;
          }

          if (state.weight.weight > 0) state.calibrationAttempts = 0;

          if (state.weight.weight < CONFIG.detection.minValidWeight) {
            log('Weight too low after photo — skipping', 'warning');
            state.aiResult = null; state.weight = null; state.itemAlreadyPositioned = false;
            await scheduleNextPhotoWithPositioning();
            return;
          }

          if (state.aiResult.materialType === 'UNKNOWN') {
            if (state.detectionRetries < CONFIG.detection.maxRetries) {
              state.detectionRetries++;
              log(`Unknown — retry ${state.detectionRetries}/${CONFIG.detection.maxRetries}`, 'warning');
              state.awaitingDetection = true;
              state.aiResult = null;
              setTimeout(async () => {
                if (!state.autoCycleEnabled) return;
                try {
                  await executeCommand('takePhoto');
                } catch (err) {
                  log(`Retry photo error: ${err.message}`, 'error');
                  state.awaitingDetection = false;
                  state.cycleInProgress = true;
                  executeRejectionCycle();
                }
              }, CONFIG.detection.retryDelay);
              return;
            }
            log(`Unknown after ${state.detectionRetries} retries — rejecting`, 'warning');
            state.cycleInProgress = true;
            executeRejectionCycle();
            return;
          }

          log('Starting auto cycle...', 'success');
          state.cycleInProgress = true;
          executeAutoCycle();
        }
        return;
      }

    } catch (error) {
      log(`WS message error: ${error.message}`, 'error');
    }
  });

  state.ws.on('error', (error) => log(`WS error: ${error.message}`, 'error'));
  state.ws.on('close', () => setTimeout(() => connectWebSocket(), 5000));
}

// ============================================
// MQTT
// ============================================
const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username:          CONFIG.mqtt.username,
  password:          CONFIG.mqtt.password,
  ca:                fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  log('MQTT connected', 'success');

  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.qrInput);
  mqttClient.subscribe(CONFIG.mqtt.topics.guestStart);

  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status:   'online',
    event:    'device_connected',
    timestamp: new Date().toISOString()
  }), { retain: true });

  // ✅ System is ready immediately — hardcoded moduleId means no WS handshake wait
  state.isReady = true;
  log(`System ready — moduleId hardcoded to ${HARDCODED_MODULE_ID}`, 'success');

  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status:   'ready',
    event:    'startup_ready',
    moduleId: state.moduleId,
    isReady:  true,
    timestamp: new Date().toISOString()
  }));

  mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
    deviceId: CONFIG.device.id,
    state:    'ready_for_qr',
    message:  'Please scan your QR code',
    timestamp: new Date().toISOString()
  }));

  // ✅ Initial bin status with retain
  mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
    deviceId:  CONFIG.device.id,
    binStatus: state.binStatus,
    timestamp: new Date().toISOString()
  }), { qos: 1, retain: true });

  connectWebSocket();
  setupQRScanner();       // ✅ Start immediately — no waiting for moduleId
  heartbeat.start();
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());

    if (topic === CONFIG.mqtt.topics.guestStart) {
      if (state.resetting || !state.isReady) return;
      if (state.autoCycleEnabled) {
        await resetSystemForNextUser(false);
        await delay(2000);
      }
      await startGuestSession(payload);
      return;
    }

    if (topic === CONFIG.mqtt.topics.qrInput) {
      if (canAcceptQRScan()) {
        processQRCode(payload.qrCode).catch(err => {
          log(`QR error: ${err.message}`, 'error');
        });
      }
      return;
    }

    if (topic === CONFIG.mqtt.topics.commands) {
      switch (payload.action) {
        case 'getStatus':
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status:   state.isReady ? 'ready' : 'initializing',
            event:    'status_response',
            isReady:  state.isReady,
            autoCycleEnabled: state.autoCycleEnabled,
            resetting: state.resetting,
            processingQR: state.processingQR,
            compactorRunning: state.compactorRunning,
            moduleId: state.moduleId,
            detectionStats: state.detectionStats,
            canAcceptQRScan: canAcceptQRScan(),
            hidDeviceActive: state.hidDevice !== null,
            timestamp: new Date().toISOString()
          })); break;

        case 'getDetectionStats': logDetectionStats(); break;

        case 'getBinStatus':
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId: CONFIG.device.id, binStatus: state.binStatus,
            timestamp: new Date().toISOString()
          }), { qos: 1, retain: true }); break;

        case 'resetBinStatus': {
          const p = payload.params || {};
          if (p.resetAll) {
            state.binStatus = { plastic: false, metal: false, right: false, glass: false };
          } else if (p.binCode !== undefined) {
            const k = { 0:'plastic',1:'metal',2:'right',3:'glass' }[p.binCode];
            if (k) state.binStatus[k] = false;
          }
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId: CONFIG.device.id, action: 'reset',
            binStatus: state.binStatus, timestamp: new Date().toISOString()
          }), { qos: 1, retain: true });
          break;
        }

        case 'emergencyStop':
          await executeCommand('closeGate');
          await executeCommand('customMotor', CONFIG.motors.belt.stop);
          await stopCompactor();
          state.autoCycleEnabled = false; state.cycleInProgress = false;
          state.resetting = false; state.isReady = false;
          break;

        case 'forceReset':
          state.cycleInProgress = false; state.resetting = false;
          await resetSystemForNextUser(true); break;

        case 'endSession': {
          state.autoCycleEnabled = false; state.awaitingDetection = false;
          if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }
          for (let i = 0; i < 2; i++) {
            try { await executeCommand('closeGate'); await delay(400); } catch (_) { /* ignore */ }
          }
          state.resetting = false;
          await resetSystemForNextUser(false);
          break;
        }

        case 'runDiagnostics': runDiagnostics(); break;

        case 'restartScanner':
          log('Manual scanner restart', 'info');
          forceRestartScanner(); break;

        default:
          if (state.moduleId) await executeCommand(payload.action, payload.params);
      }
    }

  } catch (error) {
    log(`MQTT error: ${error.message}`, 'error');
  }
});

mqttClient.on('error', (error) => log(`MQTT error: ${error.message}`, 'error'));

// ============================================
// SHUTDOWN
// ============================================
function gracefulShutdown() {
  console.log('\n⏹️  Shutting down...\n');
  clearQRProcessing();
  heartbeat.stop();
  stopCompactor();
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  clearSessionTimers();
  if (state.hidDevice) {
    try { state.hidDevice.close(); } catch (_) { /* ignore */ }
    state.hidDevice = null;
  }
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id, status: 'offline', timestamp: new Date().toISOString()
  }), { retain: true });
  if (state.ws) { try { state.ws.close(); } catch (_) { /* ignore */ } }
  setTimeout(() => { mqttClient.end(); process.exit(0); }, 1000);
}

process.on('SIGINT',  gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException',  (e) => { log(`Uncaught: ${e.message}`, 'error'); gracefulShutdown(); });
process.on('unhandledRejection', (e) => { log(`Unhandled: ${e.message}`, 'error'); });

// ============================================
// STARTUP
// ============================================
console.log('='.repeat(60));
console.log('🚀 RVM AGENT v4 — QR + MEMBER + GUEST');
console.log('='.repeat(60));
console.log(`Device:     ${CONFIG.device.id}`);
console.log(`Module ID:  ${HARDCODED_MODULE_ID} (HARDCODED)`);
console.log(`Config:     ${machineConfigPath}`);
console.log('QR scanner: ✅ node-hid direct (no WinKeyServer.exe)');
console.log('Timings:    ⚡ beltToStepper 1800  stepperReset 2200');
console.log('            ⚡ itemDropDelay  300  photoDelay   300');
console.log('            ⚡ stepper-home fire-and-forget');
console.log('Bins:       ✅ retain + qos:1');
console.log('='.repeat(60) + '\n');