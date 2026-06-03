// agent-final.js
// Base: agent-guest-only.js (optimized, working perfectly)
// Added: QR scanning via stdin (no WinKeyServer.exe) for member users
// Added: startMemberSession() for QR-validated users
// Everything else identical to the working guest-only code

const mqtt   = require('mqtt');
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const WebSocket = require('ws');
const readline  = require('readline'); // ✅ built-in Node — no native deps

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
  device: { id: DEVICE_ID },

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
      screenState:   `rvm/${DEVICE_ID}/screen/state`,
      qrInput:       `rvm/${DEVICE_ID}/qr/input`,
      guestStart:    `rvm/${DEVICE_ID}/guest/start`,
      binStatus:     `rvm/${DEVICE_ID}/bin/status`
    }
  },

  // ✅ QR scanner config (new)
  qr: {
    enabled:           true,
    minLength:         5,
    maxLength:         50,
    scanTimeout:       200,
    processingTimeout: 25000,
    debug:             false
  },

  motors: {
    belt: {
      toWeight:  { motorId: "02", type: "02" },
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
    METAL_CAN:           0.50,
    PLASTIC_BOTTLE:      0.50,
    GLASS:               0.50,
    retryDelay:          1500,
    maxRetries:          2,
    hasObjectSensor:     false,
    minValidWeight:      2,
    minConfidenceRetry:  0.50,
    positionBeforePhoto: true,
    sensorCheckInterval: 500,
    sensorCheckTimeout:  10000,
    sensorDebounce:      200
  },

  // ✅ Unchanged optimized timings from guest-only
  timing: {
    beltToWeight:       1800,
    beltToStepper:      1800,
    beltReverse:        3500,
    stepperRotate:      2200,
    stepperReset:       2200,
    compactorIdleStop:  20000,
    positionSettle:     100,
    gateOperation:      600,
    autoPhotoDelay:     2500,
    sessionTimeout:     300000,
    sessionMaxDuration: 600000,
    weightDelay:        600,
    photoDelay:         300,
    calibrationDelay:   800,
    commandDelay:       100,
    resetHomeDelay:     1000,
    itemDropDelay:      300,
    photoPositionDelay: 100
  },

  heartbeat: {
    interval:           30,
    stateCheckInterval: 30
  },

  weight: {
    coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 }
  }
};

// ============================================
// STATE MANAGEMENT
// ============================================
const state = {
  moduleId: HARDCODED_MODULE_ID,
  aiResult:  null,
  weight:    null,
  autoCycleEnabled: false,
  cycleInProgress:  false,
  calibrationAttempts: 0,
  ws:      null,
  isReady: false,

  // ✅ QR scanner state (new)
  qrBuffer:            '',
  lastCharTime:        0,
  qrTimer:             null,
  processingQR:        false,
  processingQRTimeout: null,
  rlInterface:         null,
  lastKeyboardActivity: Date.now(),

  // Session (extended for both member + guest)
  sessionId:        null,
  sessionCode:      null,
  currentUserId:    null,   // ✅ new — null for guest
  currentUserData:  null,   // ✅ new — null for guest
  isMember:         false,  // ✅ new
  isGuestSession:   false,
  itemsProcessed:   0,
  sessionStartTime: null,
  lastActivityTime: null,
  sessionTimeoutTimer: null,
  maxDurationTimer:    null,
  sessionCount:        0,

  compactorRunning:  false,
  compactorTimer:    null,
  compactorIdleTimer: null,
  lastItemTime:      null,

  gateOpen: false,

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
// UTILITY FUNCTIONS  (unchanged)
// ============================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = {
    info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️',
    debug: '🔍', perf: '⚡', crusher: '🔨', camera: '📸',
    detection: '🎯', qr: '📱'
  }[level] || 'ℹ️';
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function trackCycleTime(startTime) {
  const cycleTime = Date.now() - startTime;
  state.lastCycleTime = cycleTime;
  state.cycleCount++;
  if (state.averageCycleTime === null) {
    state.averageCycleTime = cycleTime;
  } else {
    state.averageCycleTime = (state.averageCycleTime * (state.cycleCount - 1) + cycleTime) / state.cycleCount;
  }
}

function trackDetectionAttempt(success, retryCount) {
  state.detectionStats.totalAttempts++;
  if (success) {
    if (retryCount === 0)      state.detectionStats.firstTimeSuccess++;
    else if (retryCount === 1) state.detectionStats.secondTimeSuccess++;
    else if (retryCount === 2) state.detectionStats.thirdTimeSuccess++;
    state.detectionStats.lastSuccessfulTiming = { retries: retryCount, timestamp: new Date().toISOString() };
  } else {
    state.detectionStats.failures++;
  }
  const totalRetries = (state.detectionStats.secondTimeSuccess * 1) + (state.detectionStats.thirdTimeSuccess * 2);
  const successfulAttempts = state.detectionStats.firstTimeSuccess + state.detectionStats.secondTimeSuccess + state.detectionStats.thirdTimeSuccess;
  if (successfulAttempts > 0) state.detectionStats.averageRetries = totalRetries / successfulAttempts;
  if (state.detectionStats.totalAttempts % 10 === 0) logDetectionStats();
}

function logDetectionStats() {
  const s = state.detectionStats;
  const total = s.firstTimeSuccess + s.secondTimeSuccess + s.thirdTimeSuccess + s.failures;
  if (total === 0) return;
  const r = ((s.firstTimeSuccess / total) * 100).toFixed(1);
  log(`📊 Detection: ${s.totalAttempts} total | ${r}% first-time | Avg retries: ${s.averageRetries.toFixed(2)}`, 'detection');
}

// ============================================
// QR SCANNER — stdin/keyboard (✅ NEW SECTION)
// Scanner = USB keyboard → types chars → sends \r automatically
// No WinKeyServer.exe, no node-hid, no native deps
// ============================================

function canAcceptQRScan() {
  return state.isReady &&
         !state.autoCycleEnabled &&
         !state.processingQR &&
         !state.resetting;
}

function clearQRProcessing() {
  if (state.processingQRTimeout) { clearTimeout(state.processingQRTimeout); state.processingQRTimeout = null; }
  if (state.qrTimer)             { clearTimeout(state.qrTimer);             state.qrTimer = null; }
  state.processingQR = false;
  state.qrBuffer     = '';
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
  if (!canAcceptQRScan()) return;

  const cleanCode = qrData.replace(/[\r\n\t]/g, '').trim();
  if (cleanCode.length < CONFIG.qr.minLength || cleanCode.length > CONFIG.qr.maxLength) {
    log(`Invalid QR length: ${cleanCode.length}`, 'error');
    return;
  }

  // Mark busy immediately — prevents double-scan
  state.processingQR = true;
  state.processingQRTimeout = setTimeout(() => {
    log('QR processing timeout', 'warning');
    clearQRProcessing();
  }, CONFIG.qr.processingTimeout);

  log(`QR CODE: ${cleanCode}`, 'qr');

  let sessionStarted = false;

  try {
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id, state: 'qr_validating',
      message: 'Validating...', timestamp: new Date().toISOString()
    }));

    const validation = await validateQRWithBackend(cleanCode);

    if (validation.valid) {
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId: CONFIG.device.id, state: 'qr_validated',
        message: `Welcome ${validation.user.name}!`,
        user: validation.user, timestamp: new Date().toISOString()
      }));

      await delay(1500);
      clearQRProcessing();
      sessionStarted = true;
      await startMemberSession(validation);

    } else {
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId: CONFIG.device.id, state: 'qr_invalid',
        message: validation.error, timestamp: new Date().toISOString()
      }));
      await delay(2500);
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId: CONFIG.device.id, state: 'ready_for_qr',
        message: 'Scan QR or press Start for guest', timestamp: new Date().toISOString()
      }));
    }

  } catch (error) {
    log(`QR error: ${error.message}`, 'error');
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id, state: 'error',
      message: 'Error — please try again', timestamp: new Date().toISOString()
    }));
    await delay(2500);
  } finally {
    if (!sessionStarted) clearQRProcessing();
    log('QR processing complete', 'qr');
  }
}

function setupQRScanner() {
  if (!CONFIG.qr.enabled) { log('QR scanner disabled', 'warning'); return; }

  try {
    process.stdin.setRawMode(true);
  } catch (err) {
    // Non-TTY fallback (Windows service etc.)
    log(`stdin rawMode unavailable (${err.message}) — using line mode`, 'warning');
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      state.lastKeyboardActivity = Date.now();
      if (!canAcceptQRScan()) return;
      const code = line.replace(/[\r\n]/g, '').trim();
      if (code.length >= CONFIG.qr.minLength && code.length <= CONFIG.qr.maxLength) {
        processQRCode(code).catch(err => { log(`QR error: ${err.message}`, 'error'); clearQRProcessing(); });
      }
    });
    state.rlInterface = rl;
    log('QR scanner ready (line mode)', 'success');
    return;
  }

  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  let buffer = '';

  process.stdin.on('data', (key) => {
    state.lastKeyboardActivity = Date.now();

    // Ctrl+C → graceful exit
    if (key === '\u0003') { gracefulShutdown(); return; }

    if (!canAcceptQRScan()) { buffer = ''; return; }

    const now = Date.now();

    // ENTER — scanner sends \r automatically after every scan
    if (key === '\r' || key === '\n') {
      const code = buffer.replace(/[\r\n]/g, '').trim();
      buffer = '';
      if (state.qrTimer) { clearTimeout(state.qrTimer); state.qrTimer = null; }
      if (code.length >= CONFIG.qr.minLength && code.length <= CONFIG.qr.maxLength) {
        log(`QR detected: ${code}`, 'success');
        processQRCode(code).catch(err => { log(`QR error: ${err.message}`, 'error'); clearQRProcessing(); });
      }
      return;
    }

    // Backspace
    if (key === '\u007f' || key === '\b') { buffer = buffer.slice(0, -1); return; }

    // Ignore non-printable / escape sequences
    if (key.charCodeAt(0) < 32 || key.length > 1) return;

    // Reset buffer on gap > scanTimeout (scanner chars arrive <5ms apart)
    if ((now - state.lastCharTime) > CONFIG.qr.scanTimeout && buffer.length > 0) buffer = '';

    if (buffer.length >= CONFIG.qr.maxLength) {
      buffer = '';
      if (state.qrTimer) { clearTimeout(state.qrTimer); state.qrTimer = null; }
      return;
    }

    buffer += key;
    state.lastCharTime = now;

    // Auto-submit fallback for scanners that omit Enter
    if (state.qrTimer) clearTimeout(state.qrTimer);
    state.qrTimer = setTimeout(() => {
      state.qrTimer = null;
      const code = buffer.replace(/[\r\n]/g, '').trim();
      buffer = '';
      if (code.length >= CONFIG.qr.minLength && code.length <= CONFIG.qr.maxLength) {
        log(`QR auto-detected: ${code}`, 'success');
        processQRCode(code).catch(err => { log(`QR error: ${err.message}`, 'error'); clearQRProcessing(); });
      }
    }, CONFIG.qr.scanTimeout);
  });

  state.rlInterface = { close: () => { try { process.stdin.setRawMode(false); } catch (_) {} } };
  log('QR scanner ready — waiting for scans (automatic, no keypress needed)', 'success');
}

// ============================================
// CONTINUOUS COMPACTOR  (unchanged)
// ============================================
async function startContinuousCompactor() {
  if (state.compactorIdleTimer) { clearTimeout(state.compactorIdleTimer); state.compactorIdleTimer = null; }
  if (state.compactorRunning) { resetCompactorIdleTimer(); return; }
  try {
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    state.compactorRunning = true;
    state.lastItemTime = Date.now();
    log('🔨 Compactor started', 'crusher');
    resetCompactorIdleTimer();
  } catch (error) {
    log(`❌ Failed to start compactor: ${error.message}`, 'error');
    state.compactorRunning = false;
    throw error;
  }
}

function resetCompactorIdleTimer() {
  if (state.compactorIdleTimer) clearTimeout(state.compactorIdleTimer);
  state.lastItemTime = Date.now();
  state.compactorIdleTimer = setTimeout(async () => {
    if (state.compactorRunning && state.autoCycleEnabled) {
      log('🔨 No items — stopping compactor (idle)', 'crusher');
      await stopCompactor();
    }
  }, CONFIG.timing.compactorIdleStop);
}

async function stopCompactor() {
  if (!state.compactorRunning) return;
  try { await executeCommand('customMotor', CONFIG.motors.compactor.stop); log('🔨 Compactor stopped', 'crusher'); }
  catch (error) { log(`Compactor stop error: ${error.message}`, 'error'); }
  state.compactorRunning = false;
  if (state.compactorTimer)    { clearTimeout(state.compactorTimer);    state.compactorTimer    = null; }
  if (state.compactorIdleTimer){ clearTimeout(state.compactorIdleTimer); state.compactorIdleTimer = null; }
}

// ============================================
// PHOTO DETECTION  (unchanged)
// ============================================
async function scheduleNextPhotoWithPositioning() {
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);

  state.autoPhotoTimer = setTimeout(async () => {
    if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {

      try {
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        await delay(CONFIG.timing.positionSettle);
      } catch (error) { log(`Belt pre-stop error: ${error.message}`, 'error'); }

      log('🔍 Checking weight for item presence...', 'info');

      try {
        await executeCommand('getWeight');
        await delay(CONFIG.timing.weightDelay);

        if (!state.weight || state.weight.weight < CONFIG.detection.minValidWeight) {
          log(`⚖️ No item (weight: ${state.weight ? state.weight.weight + 'g' : 'null'}) — waiting`, 'debug');
          state.weight = null;
          if (state.autoCycleEnabled) await scheduleNextPhotoWithPositioning();
          return;
        }

        log(`✅ Item detected (${state.weight.weight}g) — positioning`, 'success');
        state.weight = null;

      } catch (error) {
        log(`Weight check error: ${error.message}`, 'error');
        if (state.autoCycleEnabled) await scheduleNextPhotoWithPositioning();
        return;
      }

      state.awaitingDetection    = true;
      state.itemAlreadyPositioned = false;

      try {
        if (CONFIG.detection.positionBeforePhoto) {
          log('🔄 [1] Moving belt to camera position...', 'info');
          await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
          await delay(CONFIG.timing.beltToWeight);
          await executeCommand('customMotor', CONFIG.motors.belt.stop);
          await delay(CONFIG.timing.positionSettle);
          state.itemAlreadyPositioned = true;
          log('✅ [2] Item at camera — taking photo', 'camera');
        }

        log('📸 [3] Taking photo...', 'camera');
        await executeCommand('takePhoto');
        log('📸 Photo sent — awaiting AI result', 'camera');

      } catch (error) {
        log(`❌ Photo positioning error: ${error.message}`, 'error');
        state.awaitingDetection    = false;
        state.itemAlreadyPositioned = false;
        state.weight = null;
        try { await executeCommand('customMotor', CONFIG.motors.belt.stop); } catch (_) {}
        if (state.autoCycleEnabled) await scheduleNextPhotoWithPositioning();
      }
    }
  }, 500);
}

// ============================================
// HEALTH CHECKS  (unchanged)
// ============================================
function checkSystemHealth() {
  const status    = state.autoCycleEnabled ? 'ACTIVE' : 'IDLE';
  const compactor = state.compactorRunning ? 'ON' : 'OFF';
  const qr        = canAcceptQRScan() ? 'READY' : 'BUSY';
  log(`💓 System: ${status} | Compactor: ${compactor} | QR: ${qr}`, 'info');
}

// ============================================
// HEARTBEAT  (unchanged + qr status added)
// ============================================
const heartbeat = {
  interval: null,
  stateCheckInterval: null,
  timeout: CONFIG.heartbeat.interval,

  start() {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(async () => { await this.beat(); }, this.timeout * 1000);

    if (this.stateCheckInterval) clearInterval(this.stateCheckInterval);
    this.stateCheckInterval = setInterval(() => { checkSystemHealth(); }, CONFIG.heartbeat.stateCheckInterval * 1000);
  },

  stop() {
    if (this.interval)           { clearInterval(this.interval);           this.interval = null; }
    if (this.stateCheckInterval) { clearInterval(this.stateCheckInterval); this.stateCheckInterval = null; }
  },

  async beat() {
    const timestamp = new Date().toISOString();
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) connectWebSocket();

    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId:         CONFIG.device.id,
      status:           state.isReady ? 'ready' : 'initializing',
      event:            'heartbeat',
      moduleId:         state.moduleId,
      isReady:          state.isReady,
      autoCycleEnabled: state.autoCycleEnabled,
      canAcceptQRScan:  canAcceptQRScan(),
      processingQR:     state.processingQR,
      compactorRunning: state.compactorRunning,
      lastCycleTime:    state.lastCycleTime,
      detectionStats:   state.detectionStats,
      timestamp
    }));

    const sessionStatus   = state.autoCycleEnabled ? 'ACTIVE' : 'IDLE';
    const compactorStatus = state.compactorRunning ? '🔨' : '⚪';
    const qrStatus        = canAcceptQRScan() ? '📱 READY' : '📱 BUSY';
    console.log(`💓 ${state.moduleId} | ${sessionStatus} | ${compactorStatus} | ${qrStatus}`);
  }
};

// ============================================
// DIAGNOSTICS  (unchanged + qr status)
// ============================================
function runDiagnostics() {
  console.log('\n' + '='.repeat(60));
  console.log('🔬 SYSTEM DIAGNOSTICS');
  console.log('='.repeat(60));
  console.log('\n📱 QR Scanner:');
  console.log(`   stdin active:  ${state.rlInterface ? '✅ YES' : '❌ NO'}`);
  console.log(`   processing:    ${state.processingQR ? '⏳ YES' : '✅ NO'}`);
  console.log(`   can scan:      ${canAcceptQRScan() ? '✅ YES' : '❌ NO'}`);
  console.log('\n👁️ Detection:');
  console.log(`   positionBeforePhoto: ${CONFIG.detection.positionBeforePhoto ? '✅' : '❌'}`);
  console.log(`   itemPositioned:      ${state.itemAlreadyPositioned ? '✅' : '❌'}`);
  console.log('\n🔨 Compactor:');
  console.log(`   running:   ${state.compactorRunning ? '✅ YES' : '❌ NO'}`);
  console.log(`   last item: ${state.lastItemTime ? Math.round((Date.now()-state.lastItemTime)/1000)+'s ago' : 'N/A'}`);
  console.log('\n🗑️  Bins:');
  console.log(`   plastic: ${state.binStatus.plastic ? '❌ FULL' : '✅ OK'}`);
  console.log(`   metal:   ${state.binStatus.metal   ? '❌ FULL' : '✅ OK'}`);
  console.log(`   right:   ${state.binStatus.right   ? '❌ FULL' : '✅ OK'}`);
  console.log(`   glass:   ${state.binStatus.glass   ? '❌ FULL' : '✅ OK'}`);
  console.log('\n🎯 System:');
  console.log(`   deviceId: ${CONFIG.device.id} | moduleId: ${state.moduleId} (HARDCODED)`);
  console.log(`   isReady: ${state.isReady} | autoCycle: ${state.autoCycleEnabled}`);
  console.log(`   resetting: ${state.resetting} | cycleInProgress: ${state.cycleInProgress}`);
  console.log(`   isMember: ${state.isMember} | isGuest: ${state.isGuestSession}`);
  console.log('\n' + '='.repeat(60) + '\n');
  logDetectionStats();
}

// ============================================
// MATERIAL TYPE DETECTION  (unchanged)
// ============================================
function determineMaterialType(aiData) {
  const className   = (aiData.className || '').toLowerCase().trim();
  const probability = aiData.probability || 0;

  let materialType = 'UNKNOWN', threshold = 1.0, hasStrongKeyword = false, detectionFormat = 'unknown';

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
    detectionFormat = 'legacy_keyword';
  } else if (className.includes('plastic') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE'; threshold = CONFIG.detection.PLASTIC_BOTTLE;
    detectionFormat = 'legacy_keyword';
  } else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS'; threshold = CONFIG.detection.GLASS;
    hasStrongKeyword = className.includes('玻璃'); detectionFormat = 'glass_detected';
  }

  const pct = Math.round(probability * 100);
  if (probability < CONFIG.detection.minConfidenceRetry && materialType === 'UNKNOWN') return 'UNKNOWN';

  if (materialType !== 'UNKNOWN' && probability < threshold) {
    const relaxed = detectionFormat === 'new_standard' ? threshold * 0.70 : threshold * 0.80;
    if (hasStrongKeyword && probability >= relaxed) {
      log(`🎯 ${materialType} (${pct}% keyword)`, 'detection'); return materialType;
    }
    if (detectionFormat === 'new_standard' && probability >= 0.45) {
      log(`🎯 ${materialType} (${pct}% standard)`, 'detection'); return materialType;
    }
    log(`❌ Low confidence: ${pct}%`, 'warning'); return 'UNKNOWN';
  }

  if (materialType !== 'UNKNOWN') log(`✅ ${materialType} (${pct}%)`, 'detection');
  return materialType;
}

// ============================================
// HARDWARE CONTROL  (unchanged)
// ============================================
async function executeCommand(action, params = {}) {
  const deviceType = 1;
  let apiUrl, apiPayload;

  switch (action) {
    case 'openGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '03', deviceType };
      log('🚪 Opening gate...', 'info'); break;
    case 'closeGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '01', deviceType };
      log('🚪 Closing gate...', 'info'); break;
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
    await axios.post(apiUrl, apiPayload, { timeout: CONFIG.local.timeout, headers: { 'Content-Type': 'application/json' } });
    if (action === 'takePhoto') await delay(CONFIG.timing.photoDelay);
    if (action === 'getWeight') await delay(CONFIG.timing.weightDelay);
  } catch (error) {
    log(`${action} failed: ${error.message}`, 'error');
    throw error;
  }
}

// ============================================
// REJECTION CYCLE  (unchanged)
// ============================================
async function executeRejectionCycle() {
  log('❌ Rejecting item — reversing belt', 'warning');
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    trackDetectionAttempt(false, state.detectionRetries);
    mqttClient.publish(`rvm/${DEVICE_ID}/item/rejected`, JSON.stringify({
      deviceId: CONFIG.device.id, reason: 'LOW_CONFIDENCE',
      userId: state.currentUserId, sessionCode: state.sessionCode,
      retries: state.detectionRetries, timestamp: new Date().toISOString()
    }));
  } catch (error) { log(`Rejection error: ${error.message}`, 'error'); }

  state.aiResult = null; state.weight = null;
  state.detectionRetries = 0; state.awaitingDetection = false;
  state.cycleInProgress = false; state.itemAlreadyPositioned = false;
  if (state.autoCycleEnabled) await scheduleNextPhotoWithPositioning();
}

// ============================================
// AUTO CYCLE  (unchanged)
// ============================================
async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    state.cycleInProgress = false; return;
  }

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
    sessionType:      state.isMember ? 'member' : 'guest',
    timestamp:        new Date().toISOString()
  };

  log(`⚡ Item #${state.itemsProcessed}: ${cycleData.material} (${cycleData.weight}g) [${cycleData.sessionType}]`, 'success');

  mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));

  try {
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

    // ⚡ Fire stepper home but DON'T wait — overlaps with next detection cycle
    executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home })
      .catch(err => log(`Stepper home error: ${err.message}`, 'error'));
    await delay(200); // small buffer so command registers before freeing cycle lock

    trackCycleTime(cycleStartTime);
    resetInactivityTimer();
  } catch (error) { log(`Cycle error: ${error.message}`, 'error'); }

  state.aiResult = null; state.weight = null;
  state.cycleInProgress = false; state.detectionRetries = 0;
  state.awaitingDetection = false; state.itemAlreadyPositioned = false;
  if (state.autoCycleEnabled) await scheduleNextPhotoWithPositioning();
}

// ============================================
// SESSION MANAGEMENT
// ============================================

// ✅ NEW — Member session (QR validated)
async function startMemberSession(validationData) {
  state.sessionCount++;
  console.log('\n' + '='.repeat(50));
  console.log(`🎬 MEMBER SESSION #${state.sessionCount} — ${validationData.user.name}`);
  console.log('='.repeat(50));

  try {
    state.isReady = false;
    state.currentUserId   = validationData.user.id;
    state.sessionId       = validationData.session.sessionId;
    state.sessionCode     = validationData.session.sessionCode;
    state.currentUserData = { name: validationData.user.name, email: validationData.user.email, currentPoints: validationData.user.currentPoints };
    state.isMember       = true;
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
      deviceId: CONFIG.device.id, state: 'session_active',
      message: 'Insert your items',
      user: { name: validationData.user.name, currentPoints: validationData.user.currentPoints },
      sessionType: 'member', timestamp: new Date().toISOString()
    }));

    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id, status: 'session_active', event: 'session_started',
      sessionType: 'member', userId: state.currentUserId,
      sessionId: state.sessionId, sessionCode: state.sessionCode,
      timestamp: new Date().toISOString()
    }));

    log('⏳ Waiting 4s for first item...', 'info');
    await delay(4000);
    await scheduleNextPhotoWithPositioning();
    log('✅ Member session active', 'success');

  } catch (error) {
    log(`❌ Member session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true); throw error;
  }
}

// ✅ Guest session (unchanged from original)
async function startGuestSession(sessionData) {
  state.sessionCount++;
  console.log('\n' + '='.repeat(50));
  console.log(`🎬 GUEST SESSION #${state.sessionCount} START`);
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
      deviceId: CONFIG.device.id, state: 'session_active',
      message: 'Insert your items', sessionType: 'guest',
      timestamp: new Date().toISOString()
    }));

    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id, status: 'session_active', event: 'session_started',
      sessionType: 'guest', sessionId: state.sessionId, sessionCode: state.sessionCode,
      timestamp: new Date().toISOString()
    }));

    log('⏳ Waiting 4s for first item...', 'info');
    await delay(4000);
    await scheduleNextPhotoWithPositioning();
    log('✅ Guest session active', 'success');

  } catch (error) {
    log(`❌ Guest session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true); throw error;
  }
}

// ✅ Reset (unchanged + clears member state)
async function resetSystemForNextUser(forceStop = false) {
  const resetStartTime = Date.now();

  console.log('\n' + '='.repeat(50));
  console.log(`🔄 RESET AFTER SESSION #${state.sessionCount}`);
  console.log('='.repeat(50) + '\n');

  log('🚪 Ensuring gate is closed (reset start)...', 'info');
  try {
    await executeCommand('closeGate');
    await delay(400);
    log('✅ Gate close confirmed at reset start', 'success');
  } catch (error) {
    log(`Gate close error (non-fatal): ${error.message}`, 'error');
  }

  try {
    await executeCommand('closeGate');
    await delay(300);
    log('✅ Gate close confirmed (second attempt)', 'success');
  } catch (error) { /* ignore */ }

  state.resetting = true;

  try {
    state.autoCycleEnabled = false; state.awaitingDetection = false;
    if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }

    if (state.cycleInProgress) {
      const startWait = Date.now();
      while (state.cycleInProgress && (Date.now() - startWait) < 60000) await delay(2000);
    }

    if (forceStop) { await stopCompactor(); }
    else if (state.compactorRunning) { await delay(2000); await stopCompactor(); }

    await executeCommand('customMotor', CONFIG.motors.belt.stop);

  } catch (error) { log(`Reset error: ${error.message}`, 'error'); }
  finally {
    // Notify backend
    try {
      if (state.sessionCode && state.itemsProcessed >= 0) {
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId:       CONFIG.device.id, status: 'session_ended', event: 'session_ended',
          sessionCode:    state.sessionCode, itemsProcessed: state.itemsProcessed,
          sessionType:    state.isMember ? 'member' : 'guest',
          userId:         state.currentUserId,
          timestamp:      new Date().toISOString()
        }));
        await delay(1500);
      }
    } catch (_) {}

    // Clear all state
    state.aiResult = null; state.weight = null;
    state.sessionId = null; state.sessionCode = null;
    state.currentUserId = null; state.currentUserData = null;
    state.calibrationAttempts = 0; state.cycleInProgress = false;
    state.itemsProcessed = 0; state.sessionStartTime = null;
    state.detectionRetries = 0; state.isMember = false;
    state.isGuestSession = false; state.lastItemTime = null;
    state.itemAlreadyPositioned = false;

    clearSessionTimers();
    clearQRProcessing();

    state.resetting = false;
    state.isReady   = true;

    console.log('='.repeat(50));
    console.log('✅ READY FOR NEXT USER');
    console.log('='.repeat(50) + '\n');

    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id, status: 'ready', event: 'reset_complete',
      isReady: true, autoCycleEnabled: false, timestamp: new Date().toISOString()
    }));

    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id, state: 'waiting_for_guest',
      message: 'Scan QR code or press Start for guest', timestamp: new Date().toISOString()
    }));

    log(`⏱️ Reset done in ${Date.now() - resetStartTime}ms`, 'perf');
  }
}

// ============================================
// SESSION TIMERS  (unchanged)
// ============================================
async function handleSessionTimeout(reason) {
  log(`⏱️ Session timeout: ${reason}`, 'warning');

  for (let i = 0; i < 2; i++) {
    try { await executeCommand('closeGate'); await delay(400); } catch (_) {}
  }

  state.autoCycleEnabled = false; state.awaitingDetection = false;
  if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }

  try {
    if (state.sessionCode && state.itemsProcessed >= 0) {
      mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
        deviceId: CONFIG.device.id, status: 'session_timeout', event: 'session_timeout',
        reason, sessionCode: state.sessionCode, itemsProcessed: state.itemsProcessed,
        sessionType: state.isMember ? 'member' : 'guest', timestamp: new Date().toISOString()
      }));
      await delay(2000);
    }
  } catch (_) {}

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
  state.sessionTimeoutTimer = setTimeout(() => handleSessionTimeout('inactivity'), CONFIG.timing.sessionTimeout);
}

function startSessionTimers() {
  resetInactivityTimer();
  if (state.maxDurationTimer) clearTimeout(state.maxDurationTimer);
  state.maxDurationTimer = setTimeout(() => handleSessionTimeout('max_duration'), CONFIG.timing.sessionMaxDuration);
}

function clearSessionTimers() {
  if (state.sessionTimeoutTimer) { clearTimeout(state.sessionTimeoutTimer); state.sessionTimeoutTimer = null; }
  if (state.maxDurationTimer)    { clearTimeout(state.maxDurationTimer);    state.maxDurationTimer    = null; }
}

// ============================================
// WEBSOCKET  (unchanged)
// ============================================
function connectWebSocket() {
  if (state.ws) {
    try { state.ws.removeAllListeners(); state.ws.close(); } catch (_) {}
    state.ws = null;
  }

  state.ws = new WebSocket(CONFIG.local.wsUrl);
  state.ws.on('open', () => log('✅ WebSocket connected', 'success'));

  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.function === '01') {
        log(`WS moduleId: ${message.moduleId} (ignored — hardcoded)`, 'debug'); return;
      }

      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const materialType = determineMaterialType(aiData);
        state.aiResult = {
          matchRate: Math.round((aiData.probability || 0) * 100),
          materialType, className: aiData.className,
          taskId: aiData.taskId, timestamp: new Date().toISOString()
        };
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        if (state.autoCycleEnabled && state.awaitingDetection) {
          state.awaitingDetection = false;
          log('🔍 AI done — measuring weight', 'detection');
          setTimeout(() => executeCommand('getWeight'), 100);
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
          log(`⚠️ ${binInfo.name} bin full`, 'warning');
          if (binInfo.key) state.binStatus[binInfo.key] = true;
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId: CONFIG.device.id, binCode, binName: binInfo.name, binKey: binInfo.key,
            isFull: true, critical: binInfo.critical, binStatus: state.binStatus,
            timestamp: new Date().toISOString()
          }), { qos: 1, retain: true });
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id, state: 'bin_full_warning',
            message: `${binInfo.name} bin is full`, binCode, timestamp: new Date().toISOString()
          }));
          if (binInfo.critical && state.autoCycleEnabled) {
            const currentBin = state.aiResult?.materialType === 'METAL_CAN' ? 'metal' : 'plastic';
            if (binInfo.key === currentBin) setTimeout(async () => { await handleSessionTimeout('bin_full'); }, 2000);
          }
        }
        return;
      }

      if (message.function === '06') {
        const weightValue      = parseFloat(message.data) || 0;
        const coefficient      = CONFIG.weight.coefficients[1];
        const calibratedWeight = weightValue * (coefficient / 1000);
        state.weight = {
          weight: Math.round(calibratedWeight * 10) / 10,
          rawWeight: weightValue, coefficient, timestamp: new Date().toISOString()
        };
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));

        if (state.aiResult && state.autoCycleEnabled && !state.cycleInProgress) {
          log(`⚖️ Weight: ${state.weight.weight}g`, 'info');

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
            log('⚠️ Weight too low after photo — skipping', 'warning');
            state.aiResult = null; state.weight = null; state.itemAlreadyPositioned = false;
            await scheduleNextPhotoWithPositioning(); return;
          }

          if (state.aiResult.materialType === 'UNKNOWN') {
            if (state.detectionRetries < CONFIG.detection.maxRetries) {
              state.detectionRetries++;
              log(`🔄 Unknown — retry ${state.detectionRetries}/${CONFIG.detection.maxRetries}`, 'warning');
              state.awaitingDetection = true; state.aiResult = null;
              setTimeout(async () => {
                if (!state.autoCycleEnabled) return;
                try { await executeCommand('takePhoto'); }
                catch (err) {
                  log(`Retry photo error: ${err.message}`, 'error');
                  state.awaitingDetection = false; state.cycleInProgress = true;
                  executeRejectionCycle();
                }
              }, CONFIG.detection.retryDelay);
              return;
            }
            log(`❌ Unknown after ${state.detectionRetries} retries — rejecting`, 'warning');
            state.cycleInProgress = true; executeRejectionCycle(); return;
          }

          log('✅ Starting auto cycle...', 'success');
          state.cycleInProgress = true; executeAutoCycle();
        }
        return;
      }

    } catch (error) { log(`WS error: ${error.message}`, 'error'); }
  });

  state.ws.on('error', (error) => log(`WS error: ${error.message}`, 'error'));
  state.ws.on('close', () => setTimeout(() => connectWebSocket(), 5000));
}

// ============================================
// MQTT
// ============================================
const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca:       fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  log('✅ MQTT connected', 'success');

  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.qrInput);   // ✅ subscribe for MQTT QR input too
  mqttClient.subscribe(CONFIG.mqtt.topics.guestStart);

  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id, status: 'online', event: 'device_connected',
    timestamp: new Date().toISOString()
  }), { retain: true });

  state.isReady = true;
  log(`✅ System ready — moduleId hardcoded to ${HARDCODED_MODULE_ID}`, 'success');

  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id, status: 'ready', event: 'startup_ready',
    moduleId: state.moduleId, isReady: true, timestamp: new Date().toISOString()
  }));

  mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
    deviceId: CONFIG.device.id, state: 'waiting_for_guest',
    message: 'Scan QR code or press Start for guest', timestamp: new Date().toISOString()
  }));

  mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
    deviceId: CONFIG.device.id, binStatus: state.binStatus, timestamp: new Date().toISOString()
  }), { qos: 1, retain: true });

  log('📤 Initial bin status published', 'info');

  connectWebSocket();
  setupQRScanner();   // ✅ start QR scanner immediately
  heartbeat.start();
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());

    // ✅ Guest session start (unchanged)
    if (topic === CONFIG.mqtt.topics.guestStart) {
      if (state.resetting || !state.isReady) { log('System not ready', 'warning'); return; }
      if (state.autoCycleEnabled) { await resetSystemForNextUser(false); await delay(2000); }
      await startGuestSession(payload); return;
    }

    // ✅ QR code via MQTT (fallback for remote/web triggered scans)
    if (topic === CONFIG.mqtt.topics.qrInput) {
      if (canAcceptQRScan()) {
        processQRCode(payload.qrCode).catch(err => log(`QR error: ${err.message}`, 'error'));
      }
      return;
    }

    if (topic === CONFIG.mqtt.topics.commands) {

      if (payload.action === 'getBinStatus') {
        mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
          deviceId: CONFIG.device.id, binStatus: state.binStatus, timestamp: new Date().toISOString()
        }), { qos: 1, retain: true }); return;
      }

      if (payload.action === 'resetBinStatus') {
        const p = payload.params || {};
        if (p.resetAll) {
          state.binStatus = { plastic: false, metal: false, right: false, glass: false };
        } else if (p.binCode !== undefined) {
          const k = { 0:'plastic', 1:'metal', 2:'right', 3:'glass' }[p.binCode];
          if (k) state.binStatus[k] = false;
        }
        mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
          deviceId: CONFIG.device.id, action: 'reset',
          binStatus: state.binStatus, timestamp: new Date().toISOString()
        }), { qos: 1, retain: true }); return;
      }

      if (payload.action === 'testBinFull') {
        const binCode = payload.params?.binCode || 0;
        const binMap  = { 0: { name: 'Plastic (PET)', key: 'plastic' }, 1: { name: 'Metal Can', key: 'metal' } };
        const binInfo = binMap[binCode];
        if (binInfo?.key) {
          state.binStatus[binInfo.key] = true;
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId: CONFIG.device.id, binCode, binName: binInfo.name,
            binKey: binInfo.key, isFull: true, binStatus: state.binStatus,
            timestamp: new Date().toISOString()
          }), { qos: 1, retain: true });
          log(`🧪 TEST: ${binInfo.name} bin marked full`, 'warning');
        }
        return;
      }

      if (payload.action === 'getStatus') {
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id, status: state.isReady ? 'ready' : 'initializing',
          event: 'status_response', isReady: state.isReady,
          autoCycleEnabled: state.autoCycleEnabled, resetting: state.resetting,
          processingQR: state.processingQR, canAcceptQRScan: canAcceptQRScan(),
          compactorRunning: state.compactorRunning, moduleId: state.moduleId,
          detectionStats: state.detectionStats, timestamp: new Date().toISOString()
        })); return;
      }

      if (payload.action === 'getDetectionStats') { logDetectionStats(); return; }

      if (payload.action === 'emergencyStop') {
        await executeCommand('closeGate');
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        await stopCompactor();
        state.autoCycleEnabled = false; state.cycleInProgress = false;
        state.resetting = false; state.isReady = false; return;
      }

      if (payload.action === 'forceReset') {
        state.cycleInProgress = false; state.resetting = false;
        await resetSystemForNextUser(true); return;
      }

      if (payload.action === 'endSession') {
        console.log('\n' + '🚨'.repeat(25));
        console.log('🛑 END SESSION COMMAND RECEIVED');
        console.log('🚨'.repeat(25) + '\n');

        state.autoCycleEnabled = false;
        state.awaitingDetection = false;
        if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }

        log('🚪 IMMEDIATE GATE CLOSE - Attempt 1', 'warning');
        try { await executeCommand('closeGate'); await delay(400); log('✅ Gate close command 1 sent', 'success'); }
        catch (error) { log(`❌ Gate close attempt 1 failed: ${error.message}`, 'error'); }

        log('🚪 IMMEDIATE GATE CLOSE - Attempt 2 (safety)', 'warning');
        try { await executeCommand('closeGate'); await delay(400); log('✅ Gate close command 2 sent', 'success'); }
        catch (error) { log(`❌ Gate close attempt 2 failed: ${error.message}`, 'error'); }

        console.log('✅ Gate closing commands sent - proceeding with reset\n');
        state.resetting = false;
        await resetSystemForNextUser(false); return;
      }

      if (payload.action === 'runDiagnostics') { runDiagnostics(); return; }

      await executeCommand(payload.action, payload.params);
    }

  } catch (error) { log(`MQTT error: ${error.message}`, 'error'); }
});

mqttClient.on('error', (error) => log(`MQTT error: ${error.message}`, 'error'));

// ============================================
// SHUTDOWN
// ============================================
function gracefulShutdown() {
  console.log('\n⏹️  Shutting down...\n');
  heartbeat.stop();
  stopCompactor();
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  clearSessionTimers();
  if (state.rlInterface) { try { state.rlInterface.close(); } catch (_) {} }

  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id, status: 'offline', timestamp: new Date().toISOString()
  }), { retain: true });

  if (state.ws) { try { state.ws.close(); } catch (_) {} }
  setTimeout(() => { mqttClient.end(); process.exit(0); }, 1000);
}

process.on('SIGINT',  gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException',  (e) => { log(`Uncaught: ${e.message}`, 'error'); console.error(e); gracefulShutdown(); });
process.on('unhandledRejection', (e) => { log(`Unhandled: ${e.message}`, 'error'); console.error(e); });

// ============================================
// STARTUP
// ============================================
console.log('='.repeat(55));
console.log('🚀 RVM AGENT — GUEST + MEMBER (QR)');
console.log('='.repeat(55));
console.log(`Device:    ${CONFIG.device.id}`);
console.log(`Module ID: ${HARDCODED_MODULE_ID} (HARDCODED)`);
console.log(`Config:    ${machineConfigPath}`);
console.log('QR:        ✅ stdin mode — no WinKeyServer.exe needed');
console.log('Guest:     ✅ press Start button as before');
console.log('Member:    ✅ scan QR code to start session');
console.log('Timings:   ⚡ optimized (same as guest-only agent)');
console.log('Bins:      ✅ retain + qos:1');
console.log('='.repeat(55) + '\n');