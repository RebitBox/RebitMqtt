// agent-guest-only.js - SPEED OPTIMIZED VERSION
// Changes: Parallel motors, non-blocking compactor, reduced redundant delays
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

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
    wsUrl: 'ws://localhost:8081/websocket/qazwsx1234',
    timeout: 8000
  },
  
  mqtt: {
    brokerUrl: 'mqtts://app.rebit-japan.com:8883',
    username: 'mqttproduser',
    password: '2o25@pR0Du$3rW8tl',
    caFile: 'C:\\Users\\YY\\RebitMqtt\\certs/app.rebit-japan.com.ca-bundle',
    topics: {
      commands: `rvm/${DEVICE_ID}/commands`,
      autoControl: `rvm/${DEVICE_ID}/control/auto`,
      cycleComplete: `rvm/${DEVICE_ID}/cycle/complete`,
      aiResult: `rvm/${DEVICE_ID}/ai/result`,
      weightResult: `rvm/${DEVICE_ID}/weight/result`,
      status: `rvm/${DEVICE_ID}/status`,
      screenState: `rvm/${DEVICE_ID}/screen/state`,
      guestStart: `rvm/${DEVICE_ID}/guest/start`,
      binStatus: `rvm/${DEVICE_ID}/bin/status`
    }
  },
  
  motors: {
    belt: {
      toWeight: { motorId: "02", type: "02" },
      toStepper: { motorId: "02", type: "03" },
      reverse: { motorId: "02", type: "01" },
      stop: { motorId: "02", type: "00" }
    },
    compactor: {
      start: { motorId: "04", type: "01" },
      stop: { motorId: "04", type: "00" }
    },
    stepper: {
      moduleId: '09',
      positions: { home: '01', metalCan: '02', plasticBottle: '03' }
    }
  },
  
  detection: {
    METAL_CAN: 0.65,
    PLASTIC_BOTTLE: 0.65,
    GLASS: 0.65,
    retryDelay: 1500,
    maxRetries: 2,
    hasObjectSensor: false,
    minValidWeight: 2,
    minConfidenceRetry: 0.50,
    positionBeforePhoto: true,
    sensorCheckInterval: 500,
    sensorCheckTimeout: 10000,
    sensorDebounce: 200
  },

  timing: {
    beltToWeight: 1800,
    beltToStepper: 2200,
    beltReverse: 3500,
    stepperRotate: 2200,
    stepperReset: 3000,
    compactorIdleStop: 12000,
    positionSettle: 150,
    gateOperation: 600,
    autoPhotoDelay: 2500,
    sessionTimeout: 300000,
    sessionMaxDuration: 600000,
    weightDelay: 400,
    photoDelay: 400,
    calibrationDelay: 600,
    commandDelay: 50,
    resetHomeDelay: 800,
    itemDropDelay: 250,
    photoPositionDelay: 100,
    nextPhotoDelay: 300
  },
  
  heartbeat: {
    interval: 30,
    maxModuleIdRetries: 10,
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
  moduleId: null,
  aiResult: null,
  weight: null,
  autoCycleEnabled: false,
  cycleInProgress: false,
  calibrationAttempts: 0,
  ws: null,
  isReady: false,
  
  sessionId: null,
  sessionCode: null,
  isGuestSession: false,
  itemsProcessed: 0,
  sessionStartTime: null,
  lastActivityTime: null,
  sessionTimeoutTimer: null,
  maxDurationTimer: null,
  
  compactorRunning: false,
  compactorIdleTimer: null,
  lastItemTime: null,
  
  gateOpen: false,
  
  autoPhotoTimer: null,
  detectionRetries: 0,
  awaitingDetection: false,
  resetting: false,
  itemAlreadyPositioned: false,
  
  cycleCompleteResolve: null,
  
  binStatus: {
    plastic: false,
    metal: false,
    right: false,
    glass: false
  },
  
  lastCycleTime: null,
  averageCycleTime: null,
  cycleCount: 0,
  sessionCount: 0,
  
  detectionStats: {
    totalAttempts: 0,
    firstTimeSuccess: 0,
    secondTimeSuccess: 0,
    thirdTimeSuccess: 0,
    failures: 0,
    averageRetries: 0,
    lastSuccessfulTiming: null,
    positioningHelped: 0
  }
};

// ============================================
// UTILITY FUNCTIONS
// ============================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = {
    'info': 'ℹ️', 'success': '✅', 'error': '❌', 'warning': '⚠️',
    'debug': '🔍', 'perf': '⚡', 'crusher': '🔨', 'camera': '📸', 'detection': '🎯'
  }[level] || 'ℹ️';
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function trackCycleTime(startTime) {
  const cycleTime = Date.now() - startTime;
  state.lastCycleTime = cycleTime;
  state.cycleCount++;
  state.averageCycleTime = state.averageCycleTime === null
    ? cycleTime
    : (state.averageCycleTime * (state.cycleCount - 1) + cycleTime) / state.cycleCount;
  log(`⏱️ Cycle: ${cycleTime}ms | Avg: ${Math.round(state.averageCycleTime)}ms`, 'perf');
}

function trackDetectionAttempt(success, retryCount) {
  state.detectionStats.totalAttempts++;
  if (success) {
    if (retryCount === 0) state.detectionStats.firstTimeSuccess++;
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
  log(`📊 Detection: ${s.totalAttempts} total | ${((s.firstTimeSuccess / total) * 100).toFixed(1)}% first-time | Avg retries: ${s.averageRetries.toFixed(2)}`, 'detection');
}

function waitForCycleComplete(timeoutMs = 30000) {
  if (!state.cycleInProgress) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { state.cycleCompleteResolve = null; resolve(); }, timeoutMs);
    state.cycleCompleteResolve = () => { clearTimeout(timer); state.cycleCompleteResolve = null; resolve(); };
  });
}

function signalCycleComplete() {
  if (state.cycleCompleteResolve) state.cycleCompleteResolve();
}

// ============================================
// COMPACTOR (NON-BLOCKING)
// ============================================
function startCompactorAsync() {
  if (state.compactorIdleTimer) { clearTimeout(state.compactorIdleTimer); state.compactorIdleTimer = null; }
  if (state.compactorRunning) { resetCompactorIdleTimer(); return; }
  
  executeCommand('customMotor', CONFIG.motors.compactor.start)
    .then(() => {
      state.compactorRunning = true;
      state.lastItemTime = Date.now();
      log('🔨 Compactor started', 'crusher');
      resetCompactorIdleTimer();
    })
    .catch((error) => {
      log(`❌ Failed to start compactor: ${error.message}`, 'error');
      state.compactorRunning = false;
    });
}

function resetCompactorIdleTimer() {
  if (state.compactorIdleTimer) clearTimeout(state.compactorIdleTimer);
  state.lastItemTime = Date.now();
  state.compactorIdleTimer = setTimeout(async () => {
    if (state.compactorRunning && state.autoCycleEnabled) {
      log('🔨 Compactor idle - stopping', 'crusher');
      await stopCompactor();
    }
  }, CONFIG.timing.compactorIdleStop);
}

async function stopCompactor() {
  if (!state.compactorRunning) return;
  try {
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    log('🔨 Compactor stopped', 'crusher');
  } catch (error) {
    log(`Compactor stop error: ${error.message}`, 'error');
  }
  state.compactorRunning = false;
  if (state.compactorIdleTimer) { clearTimeout(state.compactorIdleTimer); state.compactorIdleTimer = null; }
}

// ============================================
// HARDWARE CONTROL (NO BUILT-IN DELAYS)
// ============================================
async function executeCommand(action, params = {}) {
  const deviceType = 1;
  if (!state.moduleId && action !== 'getModuleId') throw new Error('Module ID not available');
  
  let apiUrl, apiPayload;
  switch (action) {
    case 'openGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '03', deviceType };
      break;
    case 'closeGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '01', deviceType };
      break;
    case 'getWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/getWeight`;
      apiPayload = { moduleId: state.moduleId, type: '00' };
      break;
    case 'calibrateWeight':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/weightCalibration`;
      apiPayload = { moduleId: state.moduleId, type: '00' };
      break;
    case 'takePhoto':
      apiUrl = `${CONFIG.local.baseUrl}/system/camera/process`;
      apiPayload = {};
      break;
    case 'stepperMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/stepMotorSelect`;
      apiPayload = { moduleId: CONFIG.motors.stepper.moduleId, id: params.position, type: params.position, deviceType };
      break;
    case 'customMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: params.motorId, type: params.type, deviceType };
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
  
  await axios.post(apiUrl, apiPayload, {
    timeout: CONFIG.local.timeout,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ============================================
// PHOTO DETECTION (OPTIMIZED)
// ============================================
async function scheduleNextPhotoWithPositioning() {
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  
  state.autoPhotoTimer = setTimeout(async () => {
    if (!state.autoCycleEnabled || state.cycleInProgress || state.awaitingDetection) return;
    
    try {
      await executeCommand('customMotor', CONFIG.motors.belt.stop);
      await delay(CONFIG.timing.positionSettle);
    } catch (error) {
      log(`Belt pre-stop error: ${error.message}`, 'error');
    }
    
    try {
      await executeCommand('getWeight');
      await delay(CONFIG.timing.weightDelay);
      
      if (!state.weight || state.weight.weight < CONFIG.detection.minValidWeight) {
        state.weight = null;
        if (state.autoCycleEnabled) scheduleNextPhotoWithPositioning();
        return;
      }
      
      log(`✅ Item detected (${state.weight.weight}g) - positioning`, 'success');
      state.weight = null;
    } catch (error) {
      log(`Weight check error: ${error.message}`, 'error');
      if (state.autoCycleEnabled) scheduleNextPhotoWithPositioning();
      return;
    }
    
    state.awaitingDetection = true;
    state.itemAlreadyPositioned = false;
    
    try {
      if (CONFIG.detection.positionBeforePhoto) {
        log('🔄 Moving belt to camera position...', 'info');
        await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
        await delay(CONFIG.timing.beltToWeight);
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        await delay(CONFIG.timing.positionSettle);
        state.itemAlreadyPositioned = true;
      }
      
      log('📸 Taking photo...', 'camera');
      await executeCommand('takePhoto');
      await delay(CONFIG.timing.photoDelay);
      
    } catch (error) {
      log(`❌ Photo error: ${error.message}`, 'error');
      state.awaitingDetection = false;
      state.itemAlreadyPositioned = false;
      state.weight = null;
      try { await executeCommand('customMotor', CONFIG.motors.belt.stop); } catch (_) {}
      if (state.autoCycleEnabled) scheduleNextPhotoWithPositioning();
    }
  }, CONFIG.timing.nextPhotoDelay);
}

// ============================================
// REJECTION CYCLE
// ============================================
async function executeRejectionCycle() {
  log('❌ Rejecting item - reversing belt', 'warning');
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    trackDetectionAttempt(false, state.detectionRetries);
    mqttClient.publish(`rvm/${DEVICE_ID}/item/rejected`, JSON.stringify({
      deviceId: CONFIG.device.id, reason: 'LOW_CONFIDENCE',
      sessionCode: state.sessionCode, retries: state.detectionRetries,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    log(`Rejection error: ${error.message}`, 'error');
  }
  state.aiResult = null; state.weight = null; state.detectionRetries = 0;
  state.awaitingDetection = false; state.cycleInProgress = false; state.itemAlreadyPositioned = false;
  signalCycleComplete();
  if (state.autoCycleEnabled) scheduleNextPhotoWithPositioning();
}

// ============================================
// AUTO CYCLE (OPTIMIZED - PARALLEL OPERATIONS)
// ============================================
async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    state.cycleInProgress = false;
    signalCycleComplete();
    return;
  }

  const cycleStartTime = Date.now();
  state.itemsProcessed++;
  trackDetectionAttempt(true, state.detectionRetries);
  if (state.itemAlreadyPositioned && state.detectionRetries > 0) state.detectionStats.positioningHelped++;
  
  const material = state.aiResult.materialType;
  const weight = state.weight.weight;
  
  const cycleData = {
    deviceId: CONFIG.device.id, material, weight,
    sessionCode: state.sessionCode, itemNumber: state.itemsProcessed,
    detectionRetries: state.detectionRetries, itemWasPositioned: state.itemAlreadyPositioned,
    timestamp: new Date().toISOString()
  };
  
  log(`⚡ Item #${state.itemsProcessed}: ${material} (${weight}g)`, 'success');
  mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));

  try {
    // ✅ OPTIMIZATION 1: Compactor fire-and-forget
    startCompactorAsync();
    
    // ✅ OPTIMIZATION 2: Belt + stepper run in PARALLEL
    const targetPosition = material === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    log(`🔄 Belt→stepper + stepper→${material === 'METAL_CAN' ? 'metal' : 'plastic'} (parallel)`, 'perf');
    
    await Promise.all([
      (async () => {
        await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
        await delay(CONFIG.timing.beltToStepper);
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
      })(),
      (async () => {
        await executeCommand('stepperMotor', { position: targetPosition });
        await delay(CONFIG.timing.stepperRotate);
      })()
    ]);
    
    await delay(CONFIG.timing.itemDropDelay);
    resetCompactorIdleTimer();
    
    // ✅ OPTIMIZATION 3: Stepper reset NON-BLOCKING
    executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home })
      .then(() => delay(CONFIG.timing.stepperReset))
      .catch(err => log(`Stepper reset error: ${err.message}`, 'error'));

    trackCycleTime(cycleStartTime);
    resetInactivityTimer();
  } catch (error) {
    log(`Cycle error: ${error.message}`, 'error');
  }

  state.aiResult = null; state.weight = null; state.cycleInProgress = false;
  state.detectionRetries = 0; state.awaitingDetection = false; state.itemAlreadyPositioned = false;
  signalCycleComplete();

  if (state.autoCycleEnabled) {
    await delay(400);
    scheduleNextPhotoWithPositioning();
  }
}

// ============================================
// GATE HELPER
// ============================================
async function closeGateSafe() {
  try {
    await executeCommand('closeGate');
    await delay(300);
  } catch (error) {
    log(`Gate close attempt 1 failed: ${error.message}`, 'error');
    try { await executeCommand('closeGate'); await delay(300); } catch (_) {}
  }
}

// ============================================
// GUEST SESSION MANAGEMENT
// ============================================
async function startGuestSession(sessionData) {
  state.sessionCount++;
  console.log('\n' + '='.repeat(50));
  console.log(`🎬 GUEST SESSION #${state.sessionCount} START`);
  console.log('='.repeat(50));
  
  try {
    state.isReady = false;
    state.sessionId = sessionData.sessionId;
    state.sessionCode = sessionData.sessionCode;
    state.isGuestSession = true;
    state.autoCycleEnabled = true;
    state.itemsProcessed = 0;
    state.sessionStartTime = new Date();
    startSessionTimers();
    
    // ✅ Parallel setup
    await Promise.all([
      executeCommand('customMotor', CONFIG.motors.belt.stop),
      stopCompactor(),
      (async () => {
        await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
        await delay(CONFIG.timing.resetHomeDelay);
      })()
    ]);
    
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
    
    log('⏳ Waiting for first item...', 'info');
    await delay(2500);
    scheduleNextPhotoWithPositioning();
    log('✅ Guest session active', 'success');
  } catch (error) {
    log(`❌ Session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function resetSystemForNextUser(forceStop = false) {
  const resetStartTime = Date.now();
  console.log('\n' + '='.repeat(50));
  console.log(`🔄 RESET AFTER SESSION #${state.sessionCount}`);
  console.log('='.repeat(50) + '\n');
  
  await closeGateSafe();
  state.resetting = true;
  
  try {
    state.autoCycleEnabled = false;
    state.awaitingDetection = false;
    if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }
    
    if (state.cycleInProgress) {
      log('⏳ Waiting for cycle...', 'info');
      await waitForCycleComplete();
    }
    
    if (forceStop) { await stopCompactor(); }
    else if (state.compactorRunning) { await delay(1500); await stopCompactor(); }
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
  } catch (error) {
    log(`Reset error: ${error.message}`, 'error');
  } finally {
    try {
      if (state.sessionCode) {
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id, status: 'session_ended', event: 'session_ended',
          sessionCode: state.sessionCode, itemsProcessed: state.itemsProcessed,
          sessionType: 'guest', timestamp: new Date().toISOString()
        }));
        await delay(1000);
      }
    } catch (_) {}
    
    state.aiResult = null; state.weight = null; state.sessionId = null;
    state.sessionCode = null; state.calibrationAttempts = 0; state.cycleInProgress = false;
    state.itemsProcessed = 0; state.sessionStartTime = null; state.detectionRetries = 0;
    state.isGuestSession = false; state.lastItemTime = null; state.itemAlreadyPositioned = false;
    clearSessionTimers();
    state.resetting = false;
    state.isReady = true;
    
    console.log('='.repeat(50));
    console.log('✅ READY FOR NEXT USER');
    console.log('='.repeat(50) + '\n');
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id, status: 'ready', event: 'reset_complete',
      isReady: true, autoCycleEnabled: false, timestamp: new Date().toISOString()
    }));
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id, state: 'waiting_for_guest',
      message: 'Press Start to begin', timestamp: new Date().toISOString()
    }));
    log(`⏱️ Reset completed in ${Date.now() - resetStartTime}ms`, 'perf');
  }
}

// ============================================
// SESSION TIMERS
// ============================================
async function handleSessionTimeout(reason) {
  log(`⏱️ Session timeout: ${reason}`, 'warning');
  await closeGateSafe();
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }
  
  try {
    if (state.sessionCode) {
      mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
        deviceId: CONFIG.device.id, status: 'session_timeout', event: 'session_timeout',
        reason, sessionCode: state.sessionCode, itemsProcessed: state.itemsProcessed,
        sessionType: 'guest', timestamp: new Date().toISOString()
      }));
      await delay(1500);
    }
  } catch (_) {}
  
  if (state.cycleInProgress) await waitForCycleComplete();
  state.resetting = false;
  await resetSystemForNextUser(false);
}

function resetInactivityTimer() {
  if (state.sessionTimeoutTimer) clearTimeout(state.sessionTimeoutTimer);
  state.lastActivityTime = Date.now();
  state.sessionTimeoutTimer = setTimeout(() => handleSessionTimeout('inactivity'), CONFIG.timing.sessionTimeout);
}

function startSessionTimers() {
  resetInactivityTimer();
  if (state.maxDurationTimer) clearTimeout(state.maxDurationTimer);
  state.maxDurationTimer = setTimeout(() => handleSessionTimeout('max_duration'), CONFIG.timing.sessionMaxDuration);
}

function clearSessionTimers() {
  if (state.sessionTimeoutTimer) { clearTimeout(state.sessionTimeoutTimer); state.sessionTimeoutTimer = null; }
  if (state.maxDurationTimer) { clearTimeout(state.maxDurationTimer); state.maxDurationTimer = null; }
}

// ============================================
// MATERIAL TYPE DETECTION
// ============================================
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase().trim();
  const probability = aiData.probability || 0;
  let materialType = 'UNKNOWN', threshold = 1.0, hasStrongKeyword = false, detectionFormat = 'unknown';
  
  if (className === '0-pet' || className.startsWith('0-pet')) {
    materialType = 'PLASTIC_BOTTLE'; threshold = CONFIG.detection.PLASTIC_BOTTLE; hasStrongKeyword = true; detectionFormat = 'new_standard';
  } else if (className === '1-can' || className.startsWith('1-can')) {
    materialType = 'METAL_CAN'; threshold = CONFIG.detection.METAL_CAN; hasStrongKeyword = true; detectionFormat = 'new_standard';
  } else if (/^0[-_\s]*(pet|plastic|bottle)/i.test(className)) {
    materialType = 'PLASTIC_BOTTLE'; threshold = CONFIG.detection.PLASTIC_BOTTLE; hasStrongKeyword = true; detectionFormat = 'variant_format';
  } else if (/^1[-_\s]*(can|metal|aluminum)/i.test(className)) {
    materialType = 'METAL_CAN'; threshold = CONFIG.detection.METAL_CAN; hasStrongKeyword = true; detectionFormat = 'variant_format';
  } else if (className.includes('易拉罐') || className.includes('铝')) {
    materialType = 'METAL_CAN'; threshold = CONFIG.detection.METAL_CAN; hasStrongKeyword = true; detectionFormat = 'legacy_chinese';
  } else if (className.includes('pet') || className.includes('瓶')) {
    materialType = 'PLASTIC_BOTTLE'; threshold = CONFIG.detection.PLASTIC_BOTTLE; hasStrongKeyword = className.includes('pet'); detectionFormat = 'legacy_keyword';
  } else if (className.includes('metal') || className.includes('can')) {
    materialType = 'METAL_CAN'; threshold = CONFIG.detection.METAL_CAN; hasStrongKeyword = false; detectionFormat = 'legacy_keyword';
  } else if (className.includes('plastic') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE'; threshold = CONFIG.detection.PLASTIC_BOTTLE; hasStrongKeyword = false; detectionFormat = 'legacy_keyword';
  } else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS'; threshold = CONFIG.detection.GLASS; hasStrongKeyword = className.includes('玻璃'); detectionFormat = 'glass_detected';
  }
  
  const pct = Math.round(probability * 100);
  if (probability < CONFIG.detection.minConfidenceRetry && materialType === 'UNKNOWN') return 'UNKNOWN';
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    const relaxed = detectionFormat === 'new_standard' ? threshold * 0.70 : threshold * 0.80;
    if (hasStrongKeyword && probability >= relaxed) { log(`🎯 ${materialType} (${pct}% - keyword)`, 'detection'); return materialType; }
    if (detectionFormat === 'new_standard' && probability >= 0.45) { log(`🎯 ${materialType} (${pct}% - standard)`, 'detection'); return materialType; }
    log(`❌ Low confidence: ${pct}%`, 'warning'); return 'UNKNOWN';
  }
  if (materialType !== 'UNKNOWN') log(`✅ ${materialType} (${pct}%)`, 'detection');
  return materialType;
}

// ============================================
// HEALTH / DIAGNOSTICS
// ============================================
function checkSystemHealth() {
  log(`💓 System: ${state.autoCycleEnabled ? 'ACTIVE' : 'IDLE'} | Compactor: ${state.compactorRunning ? 'ON' : 'OFF'}`, 'info');
}

function runDiagnostics() {
  console.log('\n' + '='.repeat(60));
  console.log('🔬 DIAGNOSTICS - SPEED OPTIMIZED');
  console.log('='.repeat(60));
  console.log(`   Device: ${CONFIG.device.id} | Sensor: OFF`);
  console.log(`   Compactor: ${state.compactorRunning ? 'ON' : 'OFF'} | Last: ${state.lastItemTime ? Math.round((Date.now() - state.lastItemTime)/1000) + 's ago' : 'N/A'}`);
  console.log(`   Bins: PET=${state.binStatus.plastic?'FULL':'OK'} Metal=${state.binStatus.metal?'FULL':'OK'}`);
  console.log(`   Cycle: ${state.lastCycleTime || 'N/A'}ms | Avg: ${state.averageCycleTime ? Math.round(state.averageCycleTime) : 'N/A'}ms`);
  console.log('='.repeat(60) + '\n');
  logDetectionStats();
}

// ============================================
// MQTT HEARTBEAT
// ============================================
const heartbeat = {
  interval: null, stateCheckInterval: null,
  timeout: CONFIG.heartbeat.interval, moduleIdRetries: 0,
  maxModuleIdRetries: CONFIG.heartbeat.maxModuleIdRetries,
  
  start() {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(async () => await this.beat(), this.timeout * 1000);
    if (this.stateCheckInterval) clearInterval(this.stateCheckInterval);
    this.stateCheckInterval = setInterval(() => checkSystemHealth(), CONFIG.heartbeat.stateCheckInterval * 1000);
  },
  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.stateCheckInterval) { clearInterval(this.stateCheckInterval); this.stateCheckInterval = null; }
  },
  async beat() {
    const timestamp = new Date().toISOString();
    if (!state.moduleId && this.moduleIdRetries < this.maxModuleIdRetries) {
      this.moduleIdRetries++;
      await requestModuleId();
      await delay(1000);
      if (state.moduleId) {
        this.moduleIdRetries = 0;
        if (!state.isReady) {
          state.isReady = true;
          log('✅ System ready', 'success');
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id, status: 'ready', event: 'startup_ready',
            moduleId: state.moduleId, isReady: true, mode: 'guest_only', sensorEnabled: false, timestamp
          }));
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id, state: 'waiting_for_guest', message: 'Press Start to begin', timestamp
          }));
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId: CONFIG.device.id, binStatus: state.binStatus, timestamp
          }), { qos: 1, retain: true });
        }
      }
    }
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) connectWebSocket();
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id, status: state.isReady ? 'ready' : 'initializing',
      event: 'heartbeat', moduleId: state.moduleId, isReady: state.isReady,
      autoCycleEnabled: state.autoCycleEnabled, compactorRunning: state.compactorRunning,
      lastCycleTime: state.lastCycleTime,
      avgCycleTime: state.averageCycleTime ? Math.round(state.averageCycleTime) : null,
      detectionStats: state.detectionStats, mode: 'guest_only', sensorEnabled: false, timestamp
    }));
    console.log(`💓 ${state.moduleId || 'WAIT'} | ${state.autoCycleEnabled ? 'ACTIVE' : 'IDLE'} | ${state.compactorRunning ? '🔨' : '⚪'}`);
  }
};

async function requestModuleId() {
  try {
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('❌ Module ID request failed:', error.message);
  }
}

// ============================================
// WEBSOCKET
// ============================================
function connectWebSocket() {
  if (state.ws) { try { state.ws.removeAllListeners(); state.ws.close(); } catch (_) {} state.ws = null; }
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    log('✅ WebSocket connected', 'success');
    if (!state.moduleId) setTimeout(() => requestModuleId(), 1000);
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.function === '01') {
        state.moduleId = message.moduleId;
        heartbeat.moduleIdRetries = 0;
        if (!state.isReady) {
          state.isReady = true;
          log('✅ System ready', 'success');
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id, status: 'ready', moduleId: state.moduleId,
            isReady: true, mode: 'guest_only', sensorEnabled: false, timestamp: new Date().toISOString()
          }));
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id, state: 'waiting_for_guest',
            message: 'Press Start to begin', timestamp: new Date().toISOString()
          }));
        }
        return;
      }
      
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        state.aiResult = {
          matchRate: Math.round((aiData.probability || 0) * 100),
          materialType: determineMaterialType(aiData),
          className: aiData.className, taskId: aiData.taskId,
          timestamp: new Date().toISOString()
        };
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        if (state.autoCycleEnabled && state.awaitingDetection) {
          state.awaitingDetection = false;
          log('🔍 AI complete - weighing...', 'detection');
          setTimeout(() => executeCommand('getWeight'), 200);
        }
        return;
      }
      
      if (message.function === 'deviceStatus') {
        const binCode = parseInt(message.data);
        const binMap = {
          0: { name: 'Plastic (PET)', key: 'plastic', critical: true },
          1: { name: 'Metal Can', key: 'metal', critical: true },
          2: { name: 'Right Bin', key: 'right', critical: false },
          3: { name: 'Glass', key: 'glass', critical: false },
          4: { name: 'Infrared', key: null, critical: false, isObjectSensor: true }
        };
        const binInfo = binMap[binCode];
        if (!binInfo || binInfo.isObjectSensor) return;
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
          const cur = state.aiResult?.materialType === 'METAL_CAN' ? 'metal' : 'plastic';
          if (binInfo.key === cur) setTimeout(() => handleSessionTimeout('bin_full'), 2000);
        }
        return;
      }
      
      if (message.function === '06') {
        const wv = parseFloat(message.data) || 0;
        const coeff = CONFIG.weight.coefficients[1];
        state.weight = {
          weight: Math.round((wv * (coeff / 1000)) * 10) / 10,
          rawWeight: wv, coefficient: coeff, timestamp: new Date().toISOString()
        };
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
        
        if (state.aiResult && state.autoCycleEnabled && !state.cycleInProgress) {
          log(`⚖️ Weight: ${state.weight.weight}g`, 'info');
          if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
            state.calibrationAttempts++;
            setTimeout(async () => {
              await executeCommand('calibrateWeight');
              setTimeout(() => executeCommand('getWeight'), CONFIG.timing.calibrationDelay);
            }, 500);
            return;
          }
          if (state.weight.weight > 0) state.calibrationAttempts = 0;
          if (state.weight.weight < CONFIG.detection.minValidWeight) {
            state.aiResult = null; state.weight = null; state.itemAlreadyPositioned = false;
            scheduleNextPhotoWithPositioning(); return;
          }
          if (state.aiResult.materialType === 'UNKNOWN') {
            state.cycleInProgress = true;
            setTimeout(() => executeRejectionCycle(), 300); return;
          }
          log('✅ Starting cycle...', 'success');
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 300);
        }
        return;
      }
    } catch (error) {
      log(`WS error: ${error.message}`, 'error');
    }
  });
  
  state.ws.on('error', (error) => log(`WS error: ${error.message}`, 'error'));
  state.ws.on('close', () => setTimeout(() => connectWebSocket(), 5000));
}

// ============================================
// MQTT
// ============================================
const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username, password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile), rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  log('✅ MQTT connected', 'success');
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.guestStart);
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id, status: 'online', event: 'device_connected',
    mode: 'guest_only', sensorEnabled: false, timestamp: new Date().toISOString()
  }), { retain: true });
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id, status: 'ready', event: 'startup_ready',
    isReady: true, mode: 'guest_only', sensorEnabled: false, timestamp: new Date().toISOString()
  }));
  connectWebSocket();
  setTimeout(() => requestModuleId(), 2000);
  setTimeout(() => heartbeat.start(), 5000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic === CONFIG.mqtt.topics.guestStart) {
      if (state.resetting || !state.isReady) { log('Not ready', 'warning'); return; }
      if (state.autoCycleEnabled) { await resetSystemForNextUser(false); await delay(1500); }
      await startGuestSession(payload);
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.commands) {
      if (payload.action === 'getBinStatus') {
        mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
          deviceId: CONFIG.device.id, binStatus: state.binStatus, timestamp: new Date().toISOString()
        }), { qos: 1, retain: true });
        return;
      }
      if (payload.action === 'resetBinStatus') {
        const p = payload.params || {};
        if (p.resetAll) state.binStatus = { plastic: false, metal: false, right: false, glass: false };
        else if (p.binCode !== undefined) {
          const k = { 0: 'plastic', 1: 'metal', 2: 'right', 3: 'glass' }[p.binCode];
          if (k) state.binStatus[k] = false;
        }
        mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
          deviceId: CONFIG.device.id, action: 'reset', binStatus: state.binStatus, timestamp: new Date().toISOString()
        }), { qos: 1, retain: true });
        return;
      }
      if (payload.action === 'testBinFull') {
        const bc = payload.params?.binCode || 0;
        const bi = { 0: { name: 'Plastic (PET)', key: 'plastic' }, 1: { name: 'Metal Can', key: 'metal' } }[bc];
        if (bi?.key) {
          state.binStatus[bi.key] = true;
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId: CONFIG.device.id, binCode: bc, binName: bi.name, binKey: bi.key,
            isFull: true, binStatus: state.binStatus, timestamp: new Date().toISOString()
          }), { qos: 1, retain: true });
        }
        return;
      }
      if (payload.action === 'getStatus') {
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id, status: state.isReady ? 'ready' : 'initializing',
          event: 'status_response', isReady: state.isReady, autoCycleEnabled: state.autoCycleEnabled,
          resetting: state.resetting, compactorRunning: state.compactorRunning, moduleId: state.moduleId,
          detectionStats: state.detectionStats,
          avgCycleTime: state.averageCycleTime ? Math.round(state.averageCycleTime) : null,
          mode: 'guest_only', sensorEnabled: false, timestamp: new Date().toISOString()
        }));
        return;
      }
      if (payload.action === 'getDetectionStats') { logDetectionStats(); return; }
      if (payload.action === 'emergencyStop') {
        await Promise.all([
          executeCommand('closeGate').catch(() => {}),
          executeCommand('customMotor', CONFIG.motors.belt.stop).catch(() => {}),
          stopCompactor()
        ]);
        state.autoCycleEnabled = false; state.cycleInProgress = false;
        state.resetting = false; state.isReady = false;
        return;
      }
      if (payload.action === 'forceReset') {
        state.cycleInProgress = false; state.resetting = false;
        await resetSystemForNextUser(true); return;
      }
      if (payload.action === 'endSession') {
        console.log('\n🛑 END SESSION\n');
        state.autoCycleEnabled = false; state.awaitingDetection = false;
        if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }
        await closeGateSafe();
        state.resetting = false;
        await resetSystemForNextUser(false); return;
      }
      if (payload.action === 'runDiagnostics') { runDiagnostics(); return; }
      if (state.moduleId) await executeCommand(payload.action, payload.params);
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
  console.log('\n⏹️ Shutting down...\n');
  heartbeat.stop(); stopCompactor();
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  clearSessionTimers();
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id, status: 'offline', timestamp: new Date().toISOString()
  }), { retain: true });
  if (state.ws) try { state.ws.close(); } catch (_) {}
  setTimeout(() => { mqttClient.end(); process.exit(0); }, 1000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (error) => { log(`Uncaught: ${error.message}`, 'error'); console.error(error); gracefulShutdown(); });
process.on('unhandledRejection', (error) => { log(`Unhandled: ${error.message}`, 'error'); console.error(error); });

// ============================================
// STARTUP
// ============================================
console.log('='.repeat(50));
console.log('🚀 RVM AGENT - SPEED OPTIMIZED');
console.log('='.repeat(50));
console.log(`Device: ${CONFIG.device.id}`);
console.log(`Config: ${machineConfigPath}`);
console.log('Optimizations: Parallel motors, non-blocking compactor, reduced delays');
console.log('='.repeat(50) + '\n');