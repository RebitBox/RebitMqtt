// agent-production.js
// Base: agent-guest-only.js (production ready, working perfectly)
// Added: QR scanning via GlobalKeyboardListener (works even when UI has focus)
// Added: startMemberSession() for QR-validated users
// Added: validateQRWithBackend()
// Added: qrInput MQTT topic subscription
//
// ============================================================
// SCANNER LIFECYCLE FIX (scanner dies after 4-5 scans)
// ============================================================
// Root cause: every session reset spawned 2-3 WinKeyServer.exe processes
// (setupQRScanner + proc.close handler + health monitor + USB-reset callback
// all racing), and gkl.kill() did not wait for the old process to die. Each
// orphaned WinKeyServer holds its own SetWindowsHookEx low-level keyboard hook;
// after a few scans Windows throttles/drops the hook chain and input stops.
//
// Fixes:
//   1. ONE listener at a time, enforced by the scannerSettingUp guard
//      (previously declared but never used).
//   2. killListener() actually waits for the child process 'close' before
//      creating a new one, with a SIGKILL hard-fallback.
//   3. Death detection uses the library's supported config.windows.onError
//      hook AND the correct internal path (keyServer.proc, not _keyServer.proc
//      which never existed — the old crash handler silently did nothing).
//   4. killAllKeyServers() taskkill sweep on startup and shutdown removes any
//      orphans (manufacturer point 3).
//   5. SIGHUP / console-close handled so hooks are released on forced close
//      (manufacturer points 1 & 2).
//   6. Removed the redundant re-arm inside resetUSBDevice().then() — the
//      health monitor is the single fallback path.
// ============================================================

const mqtt   = require('mqtt');
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const WebSocket = require('ws');
const { exec } = require('child_process');
const { GlobalKeyboardListener } = require('node-global-key-listener'); // ✅ global hook

// ============================================
// LOAD MACHINE CONFIG
// ============================================
const DEVICE_ID = "RVM-3101-0002";

if (!DEVICE_ID) {
  console.error('❌ deviceId not found in machine-config.json');
  process.exit(1);
}

console.log(`✅ Device ID loaded: ${DEVICE_ID}`);

// ============================================
// HARDCODED MODULE ID  (unchanged)
// ============================================
const HARDCODED_MODULE_ID = '09';

// ============================================
// CONFIGURATION  (unchanged + qr block added)
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
      qrInput:       `rvm/${DEVICE_ID}/qr/input`,   // ✅ new
      guestStart:    `rvm/${DEVICE_ID}/guest/start`,
      binStatus:     `rvm/${DEVICE_ID}/bin/status`
    }
  },

  // ✅ QR config (new)
  qr: {
    enabled:            true,
    minLength:          5,
    maxLength:          50,
    scanTimeout:        200,
    processingTimeout:  25000,
    debug:              false,
    healthCheckInterval: 5000,
    killWaitTimeout:    1500,   // ✅ max wait for WinKeyServer to die before SIGKILL
    setupSettle:        300     // ✅ pause between kill and re-create
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

  // ✅ Unchanged optimised timings
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
// STATE MANAGEMENT  (unchanged + qr fields added)
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
  qrBuffer:             '',
  lastCharTime:         0,
  qrTimer:              null,
  processingQR:         false,
  processingQRTimeout:  null,
  globalKeyListener:    null,
  lastKeyboardActivity: Date.now(),
  scannerHealthTimer:   null,
  lastScannerRestart:   Date.now(),
  scannerSettingUp:     false,   // ✅ guard: only one setup at a time (now actually used)
  shuttingDown:         false,   // ✅ suppress restarts during shutdown

  // Session (extended for member + guest)
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
// QR SCANNER  (✅ rewritten lifecycle — single guarded listener)
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

// ✅ Sweep ALL WinKeyServer.exe processes (orphans included).
// Manufacturer point 3: terminate residual child processes / HID consumers.
function killAllKeyServers() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    exec('taskkill /F /IM WinKeyServer.exe /T', { timeout: 5000 }, (err, stdout) => {
      // err is expected when no process exists — ignore
      if (stdout && /SUCCESS/i.test(stdout)) {
        log('🧹 Swept orphan WinKeyServer process(es)', 'qr');
      }
      resolve();
    });
  });
}

// ✅ Kill the current listener and WAIT for its child process to actually die
// before resolving. gkl.kill() only sends SIGTERM and returns immediately;
// without this wait the dying process's hook lingers and stacks up.
function killListener() {
  return new Promise((resolve) => {
    const gkl = state.globalKeyListener;
    state.globalKeyListener = null;
    if (!gkl) return resolve();

    // Correct internal path: keyServer.proc (NOT _keyServer.proc)
    const proc = gkl.keyServer && gkl.keyServer.proc;

    try { gkl.kill(); } catch (_) { /* ignore */ }

    if (proc && !proc.killed) {
      let done = false;
      proc.once('close', () => { if (!done) { done = true; resolve(); } });
      proc.once('exit',  () => { if (!done) { done = true; resolve(); } });
      // Hard fallback — force kill if it refuses to die
      setTimeout(() => {
        if (!done) {
          done = true;
          try { proc.kill('SIGKILL'); } catch (_) {}
          resolve();
        }
      }, CONFIG.qr.killWaitTimeout);
    } else {
      // No proc handle — give the OS a moment, then continue
      setTimeout(resolve, 500);
    }
  });
}

// ✅ Guarded restart — always goes through setupQRScanner so only one
// teardown/recreate runs at a time.
function forceRestartScanner() {
  log('🔄 Restarting QR scanner...', 'warning');
  clearQRProcessing();
  setupQRScanner();
}

function startScannerHealthMonitor() {
  if (state.scannerHealthTimer) clearInterval(state.scannerHealthTimer);
  state.scannerHealthTimer = setInterval(() => {

    // Clear stuck processing state
    if (state.processingQR && !state.processingQRTimeout) {
      log('⚠️ processingQR stuck — clearing', 'warning');
      clearQRProcessing();
    }

    // Don't interfere while a setup is in progress or during shutdown
    if (state.scannerSettingUp || state.shuttingDown) return;

    // Only check scanner when system is idle (not in session)
    if (!canAcceptQRScan()) return;

    // Restart only if listener object is gone (process crashed) — this is the
    // SINGLE fallback recovery path.
    if (!state.globalKeyListener) {
      log('💊 Listener gone — restarting QR scanner...', 'warning');
      forceRestartScanner();
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

  log(`\n${'='.repeat(50)}`, 'qr');
  log(`QR CODE: ${cleanCode}`, 'qr');
  log(`${'='.repeat(50)}\n`, 'qr');

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
      // Clear BEFORE handing off — startMemberSession sets isReady=false immediately
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
        deviceId: CONFIG.device.id, state: 'waiting_for_guest',
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

// ✅ Force Windows USB device reset
// Fixes QR scanner getting stuck after motor electrical noise
// Only works if run as Administrator
async function resetUSBDevice() {
  return new Promise((resolve) => {
    // Use separate string building to avoid regex-in-template-literal parse issues
    const psScript = [
      '$dev = Get-PnpDevice | Where-Object {',
      '  $_.InstanceId -like "*VID_0525*" -and',
      '  $_.InstanceId -like "*PID_A4AC*"',
      '} | Select-Object -First 1;',
      'if ($dev) {',
      '  Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false -ErrorAction SilentlyContinue;',
      '  Start-Sleep -Milliseconds 800;',
      '  Enable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false -ErrorAction SilentlyContinue;',
      '  Write-Host "USB reset done";',
      '} else {',
      '  Write-Host "USB device not found - skipping reset";',
      '}'
    ].join(' ');

    const cmd = 'powershell -Command "' + psScript + '"';

    exec(cmd, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        log('USB reset error: ' + error.message, 'warning');
      } else {
        log('USB reset: ' + stdout.trim(), 'qr');
      }
      resolve(); // always continue even if reset fails
    });
  });
}

// ✅ Single guarded setup path. Enforces one listener at a time via
// scannerSettingUp, waits for the old process to die, then creates exactly
// one new listener.
async function setupQRScanner() {
  if (!CONFIG.qr.enabled) { log('QR scanner disabled', 'warning'); return; }
  if (state.shuttingDown) return;

  if (state.scannerSettingUp) {
    log('Scanner setup already in progress — skipping duplicate request', 'warning');
    return;
  }
  state.scannerSettingUp = true;

  try {
    await killListener();                 // wait for old child to fully die
    await delay(CONFIG.qr.setupSettle);   // let OS release the hook
    if (state.shuttingDown) return;
    createKeyboardListener();             // exactly ONE new listener
  } catch (e) {
    log(`Scanner setup error: ${e.message}`, 'error');
  } finally {
    state.scannerSettingUp = false;
  }
}

function createKeyboardListener() {
  console.log('\n' + '='.repeat(50));
  console.log('📱 QR SCANNER — CREATING LISTENER');
  console.log('='.repeat(50) + '\n');

  // Filter out console/system text that might accidentally build a buffer
  const CONSOLE_PATTERNS = [
    /^C:\\/i, /^[A-Z]:\\/i,
    /operable program/i, /batch file/i,
    /Users\\/i, /\\rebit-mqtt/i,
    /node/i, /RVM AGENT/i
  ];
  const isConsoleOutput = (text) => CONSOLE_PATTERNS.some(p => p.test(text));

  try {
    // ✅ Use the library's supported death-detection hook (onError fires on the
    // child's 'close' event). This replaces the old _keyServer.proc digging,
    // which used a non-existent path and therefore never worked.
    const gkl = new GlobalKeyboardListener({
      windows: {
        onError: (errorCode) => {
          // Only react if THIS listener is still the active one
          if (state.globalKeyListener !== gkl) return;
          log(`⚠️ WinKeyServer exited (code: ${errorCode}) — marking dead`, 'warning');
          state.globalKeyListener = null;  // health monitor will re-arm it
        }
      }
    });

    gkl.addListener((e) => {
      if (e.state !== 'DOWN') return;

      state.lastKeyboardActivity = Date.now();

      if (!canAcceptQRScan()) return;

      const now = Date.now();

      // ENTER — scanner always sends this after every scan
      if (e.name === 'RETURN' || e.name === 'ENTER') {
        if (
          state.qrBuffer.length >= CONFIG.qr.minLength &&
          state.qrBuffer.length <= CONFIG.qr.maxLength &&
          !isConsoleOutput(state.qrBuffer)
        ) {
          const qrCode = state.qrBuffer;
          state.qrBuffer = '';
          if (state.qrTimer) { clearTimeout(state.qrTimer); state.qrTimer = null; }
          log(`QR detected (ENTER): ${qrCode}`, 'success');
          processQRCode(qrCode).catch(err => {
            log(`QR async error: ${err.message}`, 'error');
            clearQRProcessing();
          });
        } else {
          state.qrBuffer = '';
        }
        return;
      }

      // Single printable character
      const char = e.name;
      if (char.length === 1) {
        // Reset buffer on gap between chars (scanner sends <5ms apart)
        if ((now - state.lastCharTime) > CONFIG.qr.scanTimeout && state.qrBuffer.length > 0) {
          state.qrBuffer = '';
        }

        if (state.qrBuffer.length >= CONFIG.qr.maxLength) {
          state.qrBuffer = '';
          if (state.qrTimer) { clearTimeout(state.qrTimer); state.qrTimer = null; }
          return;
        }

        state.qrBuffer    += char;
        state.lastCharTime = now;

        // Auto-submit fallback for scanners that omit ENTER
        if (state.qrTimer) clearTimeout(state.qrTimer);
        state.qrTimer = setTimeout(() => {
          state.qrTimer = null;
          if (
            state.qrBuffer.length >= CONFIG.qr.minLength &&
            state.qrBuffer.length <= CONFIG.qr.maxLength &&
            !isConsoleOutput(state.qrBuffer)
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

    state.globalKeyListener    = gkl;
    state.lastScannerRestart   = Date.now();
    state.lastKeyboardActivity = Date.now();
    log('✅ QR keyboard listener created — works with UI open', 'success');
    log('📱 Ready — scan QR code now', 'qr');

  } catch (error) {
    log(`❌ Failed to create keyboard listener: ${error.message}`, 'error');
    state.globalKeyListener = null;
  }
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
          log('🔄 [STEP 1] Moving belt to camera position...', 'info');
          const beltStartTime = Date.now();
          await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
          await delay(CONFIG.timing.beltToWeight);
          log(`🛑 [STEP 2] Stopping belt (ran for ${Date.now() - beltStartTime}ms)...`, 'info');
          await executeCommand('customMotor', CONFIG.motors.belt.stop);
          await delay(CONFIG.timing.positionSettle);
          state.itemAlreadyPositioned = true;
          log('✅ [STEP 3] Item at camera — ready for photo', 'camera');
        }

        log('📸 [STEP 4] Taking photo...', 'camera');
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
  const qr        = canAcceptQRScan() ? '📱 READY' : '📱 BUSY';
  log(`💓 System: ${status} | Compactor: ${compactor} | QR: ${qr}`, 'info');
}

// ============================================
// HEARTBEAT  (unchanged)
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
    const qrStatus        = canAcceptQRScan() ? '📱' : '🔒';
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
  console.log(`   Listener:    ${state.globalKeyListener ? '✅ ACTIVE' : '❌ INACTIVE'}`);
  console.log(`   SettingUp:   ${state.scannerSettingUp ? '⏳ YES' : '✅ NO'}`);
  console.log(`   Processing:  ${state.processingQR ? '⏳ YES' : '✅ NO'}`);
  console.log(`   Can scan:    ${canAcceptQRScan() ? '✅ YES' : '❌ NO'}`);
  console.log(`   Buffer:      "${state.qrBuffer}"`);
  console.log(`   Last activity: ${Math.round((Date.now()-state.lastKeyboardActivity)/1000)}s ago`);

  console.log('\n👁️ Detection:');
  console.log(`   positionBeforePhoto: ${CONFIG.detection.positionBeforePhoto ? '✅' : '❌'}`);
  console.log(`   itemPositioned:      ${state.itemAlreadyPositioned ? '✅' : '❌'}`);

  console.log('\n🔨 Compactor:');
  console.log(`   Running:   ${state.compactorRunning ? '✅ YES' : '❌ NO'}`);
  console.log(`   Last item: ${state.lastItemTime ? Math.round((Date.now()-state.lastItemTime)/1000)+'s ago' : 'N/A'}`);
  console.log(`   Idle timer: ${state.compactorIdleTimer ? '⏰ ACTIVE' : '❌ NONE'}`);

  console.log('\n🗑️  Bins:');
  console.log(`   Plastic: ${state.binStatus.plastic ? '❌ FULL' : '✅ OK'}`);
  console.log(`   Metal:   ${state.binStatus.metal   ? '❌ FULL' : '✅ OK'}`);
  console.log(`   Right:   ${state.binStatus.right   ? '❌ FULL' : '✅ OK'}`);
  console.log(`   Glass:   ${state.binStatus.glass   ? '❌ FULL' : '✅ OK'}`);

  console.log('\n🎯 System:');
  console.log(`   deviceId:  ${CONFIG.device.id}`);
  console.log(`   moduleId:  ${state.moduleId} (HARDCODED)`);
  console.log(`   isReady:   ${state.isReady}`);
  console.log(`   autoCycle: ${state.autoCycleEnabled}`);
  console.log(`   resetting: ${state.resetting}`);
  console.log(`   isMember:  ${state.isMember}`);
  console.log(`   isGuest:   ${state.isGuestSession}`);
  console.log(`   cycleInProgress: ${state.cycleInProgress}`);
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

// ✅ Call this after motor cycles complete to recover USB scanner
function scheduleQRRecovery() {
  // Wait for USB to settle after motor electrical noise, then restart listener
  setTimeout(() => {
    if (!state.autoCycleEnabled && state.isReady) {
      log('🔄 Post-motor QR recovery...', 'qr');
      forceRestartScanner();
    }
  }, 2000);
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
    deviceId:          CONFIG.device.id,
    material:          state.aiResult.materialType,
    weight:            state.weight.weight,
    userId:            state.currentUserId,
    sessionCode:       state.sessionCode,
    itemNumber:        state.itemsProcessed,
    detectionRetries:  state.detectionRetries,
    itemWasPositioned: state.itemAlreadyPositioned,
    sessionType:       state.isMember ? 'member' : 'guest',
    timestamp:         new Date().toISOString()
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

    // ⚡ Fire stepper home — DON'T wait, overlaps with next detection
    executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home })
      .catch(err => log(`Stepper home error: ${err.message}`, 'error'));
    await delay(200);

    trackCycleTime(cycleStartTime);
    resetInactivityTimer();
  } catch (error) { log(`Cycle error: ${error.message}`, 'error'); }

  state.aiResult = null; state.weight = null;
  state.cycleInProgress = false; state.detectionRetries = 0;
  state.awaitingDetection = false; state.itemAlreadyPositioned = false;

  // ✅ After motor cycle, update keyboard activity time
  // so health monitor doesn't think scanner is dead
  state.lastKeyboardActivity = Date.now();

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
    state.isReady        = false;
    state.currentUserId  = validationData.user.id;
    state.sessionId      = validationData.session.sessionId;
    state.sessionCode    = validationData.session.sessionCode;
    state.currentUserData = {
      name:          validationData.user.name,
      email:         validationData.user.email,
      currentPoints: validationData.user.currentPoints
    };
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

    log('⏳ Waiting 4 seconds for first item...', 'info');
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

    log('⏳ Waiting 4 seconds for first item...', 'info');
    await delay(4000);
    await scheduleNextPhotoWithPositioning();
    log('✅ Guest session active', 'success');

  } catch (error) {
    log(`❌ Guest session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true); throw error;
  }
}

// ✅ Reset (unchanged + clears member/qr state)
async function resetSystemForNextUser(forceStop = false) {
  const resetStartTime = Date.now();

  console.log('\n' + '='.repeat(50));
  console.log(`🔄 RESET AFTER SESSION #${state.sessionCount}`);
  console.log('='.repeat(50) + '\n');

  log('🚪 Ensuring gate is closed (reset start)...', 'info');
  try { await executeCommand('closeGate'); await delay(400); log('✅ Gate close confirmed at reset start', 'success'); }
  catch (error) { log(`Gate close error (non-fatal): ${error.message}`, 'error'); }

  try { await executeCommand('closeGate'); await delay(300); log('✅ Gate close confirmed (second attempt)', 'success'); }
  catch (_) {}

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
    try {
      if (state.sessionCode && state.itemsProcessed >= 0) {
        log(`📤 Notifying backend: Session ended (Code: ${state.sessionCode}, Items: ${state.itemsProcessed})`, 'info');
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId:       CONFIG.device.id, status: 'session_ended', event: 'session_ended',
          sessionCode:    state.sessionCode, itemsProcessed: state.itemsProcessed,
          sessionType:    state.isMember ? 'member' : 'guest',
          userId:         state.currentUserId, timestamp: new Date().toISOString()
        }));
        log('✅ Session end notification sent', 'success');
        await delay(1500);
      }
    } catch (_) {}

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

    // ✅ Re-arm the QR scanner ONCE through the guarded setup path.
    // setupQRScanner() now: (a) refuses to run if another setup is in flight,
    // (b) waits for the old WinKeyServer child to fully die before creating a
    // new one, (c) creates exactly one listener. This is the ONLY place we
    // re-arm on reset — no proc.close handler and no USB-reset callback also
    // spawn listeners anymore, so we never stack hooks.
    //
    // The expensive Windows PnP USB reset is reserved for the case where the
    // listener genuinely fails to recover (fallback below), and it runs while
    // idle so it can't stall a fresh session's belt timing.
    log('🔄 Re-arming QR scanner (single guarded setup)...', 'qr');
    setupQRScanner();

    console.log('='.repeat(50));
    console.log('✅ READY FOR NEXT USER');
    console.log('='.repeat(50) + '\n');

    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id, status: 'ready', event: 'reset_complete',
      isReady: true, autoCycleEnabled: false, timestamp: new Date().toISOString()
    }));

    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id, state: 'waiting_for_guest',
      message: 'Scan QR or press Start for guest', timestamp: new Date().toISOString()
    }));

    log('✅ System ready for next user', 'success');
    log(`⏱️ Reset completed in ${Date.now() - resetStartTime}ms`, 'perf');

    // ✅ Fallback recovery: only if the guarded re-arm above did NOT bring the
    // listener back. This is the ONLY place the heavy PnP USB reset runs, while
    // idle. It does NOT call setupQRScanner() itself — after the device returns
    // the health monitor (which sees globalKeyListener === null) re-arms once.
    setTimeout(async () => {
      if (state.isReady && !state.autoCycleEnabled && !state.globalKeyListener && !state.scannerSettingUp) {
        log('💊 Listener did not recover — running full USB reset...', 'qr');
        await resetUSBDevice();
        // No setupQRScanner() here — health monitor handles the single re-arm.
      }
    }, 4000);
  }
}

// ============================================
// SESSION TIMERS  (unchanged)
// ============================================
async function handleSessionTimeout(reason) {
  log(`⏱️ Session timeout: ${reason}`, 'warning');

  log('🚪 Closing gate immediately (timeout)', 'warning');
  try { await executeCommand('closeGate'); await delay(400); log('✅ Gate closed on timeout', 'success'); }
  catch (error) { log(`❌ Gate close error: ${error.message}`, 'error'); }
  try { await executeCommand('closeGate'); await delay(300); } catch (_) {}

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
        log(`WS moduleId: ${message.moduleId} (ignored — hardcoded ${HARDCODED_MODULE_ID})`, 'debug');
        return;
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
          log('🔍 AI detection complete — measuring weight...', 'detection');
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
          log(`⚖️ Final weight: ${state.weight.weight}g`, 'info');

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
// MQTT  (unchanged + qrInput subscription added)
// ============================================
const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username:           CONFIG.mqtt.username,
  password:           CONFIG.mqtt.password,
  ca:                 fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', async () => {
  log('✅ MQTT connected', 'success');

  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.qrInput);   // ✅ new
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
    message: 'Scan QR or press Start for guest', timestamp: new Date().toISOString()
  }));

  mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
    deviceId: CONFIG.device.id, binStatus: state.binStatus, timestamp: new Date().toISOString()
  }), { qos: 1, retain: true });

  log('📤 Initial bin status published', 'info');

  connectWebSocket();

  // ✅ Sweep any orphan WinKeyServer.exe left by a previous crash/forced close
  // BEFORE starting our own (manufacturer point 3 — no residual HID consumers).
  await killAllKeyServers();
  await delay(300);

  await setupQRScanner();       // ✅ guarded single listener
  startScannerHealthMonitor();  // ✅ single fallback recovery path
  heartbeat.start();
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());

    // Guest session start (unchanged)
    if (topic === CONFIG.mqtt.topics.guestStart) {
      if (state.resetting || !state.isReady) { log('System not ready', 'warning'); return; }
      if (state.autoCycleEnabled) {
        log('Session already active — resetting first', 'info');
        await resetSystemForNextUser(false);
        await delay(2000);
      }
      await startGuestSession(payload);
      return;
    }

    // ✅ QR code via MQTT (fallback — e.g. sent from web dashboard)
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
          log('✅ All bins reset', 'success');
        } else if (p.binCode !== undefined) {
          const k = { 0:'plastic', 1:'metal', 2:'right', 3:'glass' }[p.binCode];
          if (k) { state.binStatus[k] = false; log(`✅ ${k} bin reset`, 'success'); }
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

        state.autoCycleEnabled = false; state.awaitingDetection = false;
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

      if (payload.action === 'restartScanner') {
        log('🔄 Manual scanner restart requested', 'info');
        forceRestartScanner(); return;
      }

      await executeCommand(payload.action, payload.params);
    }

  } catch (error) { log(`MQTT error: ${error.message}`, 'error'); }
});

mqttClient.on('error', (error) => log(`MQTT error: ${error.message}`, 'error'));

// ============================================
// SHUTDOWN  (✅ now releases hooks + sweeps orphans)
// ============================================
let shutdownInProgress = false;
async function gracefulShutdown() {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  state.shuttingDown = true;

  console.log('\n⏹️  Shutting down...\n');
  heartbeat.stop();
  if (state.scannerHealthTimer) { clearInterval(state.scannerHealthTimer); state.scannerHealthTimer = null; }

  try { await stopCompactor(); } catch (_) {}
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  clearSessionTimers();
  clearQRProcessing();

  // ✅ Manufacturer points 1 & 2: ensure the keyboard hook + raw input handles
  // are released. Kill the tracked listener, then sweep any orphans so no
  // WinKeyServer.exe survives with a live SetWindowsHookEx hook.
  try { await killListener(); } catch (_) {}
  try { await killAllKeyServers(); } catch (_) {}

  try {
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id, status: 'offline', timestamp: new Date().toISOString()
    }), { retain: true });
  } catch (_) {}

  if (state.ws) { try { state.ws.close(); } catch (_) {} }
  setTimeout(() => { try { mqttClient.end(); } catch (_) {} process.exit(0); }, 1000);
}

process.on('SIGINT',  gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('SIGHUP',  gracefulShutdown);   // ✅ console window closed / hangup
process.on('uncaughtException',  (e) => { log(`Uncaught: ${e.message}`, 'error'); console.error(e); gracefulShutdown(); });
process.on('unhandledRejection', (e) => { log(`Unhandled: ${e && e.message}`, 'error'); console.error(e); });

// ✅ On Windows, surface CTRL+CLOSE / window-close as SIGINT so the hook is
// unregistered before the process dies (manufacturer point 1).
if (process.platform === 'win32') {
  try {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => process.emit('SIGINT'));
  } catch (_) { /* stdin may be unavailable under some launchers */ }
}

// ============================================
// STARTUP
// ============================================
console.log('='.repeat(55));
console.log('🚀 RVM AGENT — GUEST + MEMBER (QR)');
console.log('='.repeat(55));
console.log(`Device:    ${CONFIG.device.id}`);
console.log(`Module ID: ${HARDCODED_MODULE_ID} (HARDCODED)`);
console.log('QR:        ✅ GlobalKeyboardListener (single guarded listener)');
console.log('Guest:     ✅ press Start button as before');
console.log('Member:    ✅ scan QR code to start session');
console.log('Timings:   ⚡ optimized (same as guest-only agent)');
console.log('Bins:      ✅ retain + qos:1');
console.log('Scanner:   ✅ kill-and-wait + orphan sweep + hook release on exit');
console.log('='.repeat(55) + '\n');