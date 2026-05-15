// agent-guest-only.js - SPEED OPTIMIZED VERSION (GATE FIX)
// Parallel motors ONLY where different moduleIds, sequential session startup
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

  // ✅ OPTIMIZED TIMING VALUES (conservative — proven safe)
  timing: {
    beltToWeight: 1800,
    beltToStepper: 2200,
    beltReverse: 3500,
    stepperRotate: 2200,
    stepperReset: 3000,
    compactorIdleStop: 12000,
    positionSettle: 150,          // was 200
    gateOperation: 600,
    autoPhotoDelay: 2500,
    sessionTimeout: 300000,
    sessionMaxDuration: 600000,
    weightDelay: 400,             // was 600
    photoDelay: 400,              // was 600
    calibrationDelay: 600,        // was 800
    commandDelay: 100,            // keep 100 for gate safety
    resetHomeDelay: 1000,         // keep original — session startup only
    itemDropDelay: 250,           // was 300
    photoPositionDelay: 100,
    nextPhotoDelay: 300           // was 500
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
  compactorTimer: null,
  compactorIdleTimer: null,
  lastItemTime: null,
  
  gateOpen: false,
  
  autoPhotoTimer: null,
  detectionRetries: 0,
  awaitingDetection: false,
  resetting: false,
  itemAlreadyPositioned: false,
  
  // Promise-based cycle completion (replaces blocking while-loop)
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

// Promise-based cycle completion (replaces blocking while-loop)
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
// COMPACTOR (NON-BLOCKING from cycle path)
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
      log('🔨 No items detected - stopping compactor (idle)', 'crusher');
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
  if (state.compactorTimer) { clearTimeout(state.compactorTimer); state.compactorTimer = null; }
  if (state.compactorIdleTimer) { clearTimeout(state.compactorIdleTimer); state.compactorIdleTimer = null; }
}

// ============================================
// HARDWARE CONTROL
// ============================================
async function executeCommand(action, params = {}) {
  const deviceType = 1;
  
  if (!state.moduleId && action !== 'getModuleId') {
    throw new Error('Module ID not available');
  }
  
  let apiUrl, apiPayload;
  
  switch (action) {
    case 'openGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '03', deviceType };
      log('🚪 Opening gate...', 'info');
      break;
    case 'closeGate':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '01', deviceType };
      log('🚪 Closing gate...', 'info');
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
  
  try {
    await axios.post(apiUrl, apiPayload, {
      timeout: CONFIG.local.timeout,
      headers: { 'Content-Type': 'application/json' }
    });
    
    // ✅ RESTORED: Built-in delays for photo and weight
    // These commands need time for hardware to respond via WebSocket
    if (action === 'takePhoto') await delay(CONFIG.timing.photoDelay);
    if (action === 'getWeight') await delay(CONFIG.timing.weightDelay);
    
  } catch (error) {
    log(`${action} failed: ${error.message}`, 'error');
    throw error;
  }
}

// ============================================
// PHOTO DETECTION (OPTIMIZED - fewer belt stops)
// ============================================
async function scheduleNextPhotoWithPositioning() {
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  
  state.autoPhotoTimer = setTimeout(async () => {
    if (!state.autoCycleEnabled || state.cycleInProgress || state.awaitingDetection) return;
    
    // ONE belt stop before weight check (was THREE in old version)
    try {
      await executeCommand('customMotor', CONFIG.motors.belt.stop);
      await delay(CONFIG.timing.positionSettle);
    } catch (error) {
      log(`Belt pre-stop error: ${error.message}`, 'error');
    }
    
    log('🔍 Checking weight for item presence...', 'info');
    
    try {
      await executeCommand('getWeight');
      // weightDelay is now inside executeCommand
      
      if (!state.weight || state.weight.weight < CONFIG.detection.minValidWeight) {
        log(`⚖️ No item detected (weight: ${state.weight ? state.weight.weight + 'g' : 'null'}) - waiting...`, 'debug');
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
        // Belt is ALREADY stopped from above — no redundant stop needed
        log('🔄 Moving belt to camera position...', 'info');
        
        await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
        await delay(CONFIG.timing.beltToWeight);
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        await delay(CONFIG.timing.positionSettle);
        
        state.itemAlreadyPositioned = true;
        log('✅ Item positioned at camera', 'camera');
      }
      
      log('📸 Taking photo...', 'camera');
      await executeCommand('takePhoto');
      // photoDelay is now inside executeCommand
      log('📸 Photo command sent - waiting for AI result...', 'camera');
      
    } catch (error) {
      log(`❌ Photo positioning error: ${error.message}`, 'error');
      state.awaitingDetection = false;
      state.itemAlreadyPositioned = false;
      state.weight = null;
      try { await executeCommand('customMotor', CONFIG.motors.belt.stop); } catch (_) {}
      if (state.autoCycleEnabled) scheduleNextPhotoWithPositioning();
    }
  }, CONFIG.timing.nextPhotoDelay);   // 300ms (was 500ms)
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
      deviceId: CONFIG.device.id,
      reason: 'LOW_CONFIDENCE',
      sessionCode: state.sessionCode,
      retries: state.detectionRetries,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    log(`Rejection error: ${error.message}`, 'error');
  }

  state.aiResult = null;
  state.weight = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  state.cycleInProgress = false;
  state.itemAlreadyPositioned = false;
  signalCycleComplete();

  if (state.autoCycleEnabled) scheduleNextPhotoWithPositioning();
}

// ============================================
// AUTO CYCLE (OPTIMIZED - parallel belt+stepper)
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
  
  if (state.itemAlreadyPositioned && state.detectionRetries > 0) {
    state.detectionStats.positioningHelped++;
  }
  
  const material = state.aiResult.materialType;
  const weight = state.weight.weight;
  
  const cycleData = {
    deviceId: CONFIG.device.id,
    material,
    weight,
    sessionCode: state.sessionCode,
    itemNumber: state.itemsProcessed,
    detectionRetries: state.detectionRetries,
    itemWasPositioned: state.itemAlreadyPositioned,
    timestamp: new Date().toISOString()
  };
  
  log(`⚡ Item #${state.itemsProcessed}: ${material} (${weight}g)`, 'success');

  // Publish cycle complete immediately — backend starts DB writes while motors move
  mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));

  try {
    // OPTIMIZATION 1: Compactor fire-and-forget (was: await startContinuousCompactor())
    startCompactorAsync();
    
    // OPTIMIZATION 2: Belt + stepper run in PARALLEL
    // ✅ SAFE: Belt uses state.moduleId, stepper uses moduleId '09' — different serial addresses
    const targetPosition = material === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    log(`🔄 Belt→stepper + stepper→${material === 'METAL_CAN' ? 'metal' : 'plastic'} (parallel)`, 'perf');
    
    await Promise.all([
      // Belt: uses state.moduleId via customMotor → motorSelect endpoint
      (async () => {
        await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
        await delay(CONFIG.timing.beltToStepper);   // 2200ms
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
      })(),
      // Stepper: uses moduleId '09' via stepMotorSelect endpoint (DIFFERENT endpoint + moduleId)
      (async () => {
        await executeCommand('stepperMotor', { position: targetPosition });
        await delay(CONFIG.timing.stepperRotate);    // 2200ms
      })()
    ]);
    // SAVED: ~2200ms (was ~4400ms sequential, now ~2200ms parallel)
    
    await delay(CONFIG.timing.itemDropDelay);   // wait for item to drop into bin
    
    // Reset compactor idle timer AFTER item drops
    resetCompactorIdleTimer();
    
    // OPTIMIZATION 3: Stepper reset is NON-BLOCKING
    // Next photo cycle starts while stepper returns home
    // Safe: next cycle needs weight check (~300ms + ~150ms + ~400ms + ~1800ms + ~150ms = ~2800ms)
    // before stepper is needed again. Stepper home takes ~3000ms — tight but sufficient
    executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home })
      .then(() => delay(CONFIG.timing.stepperReset))
      .then(() => log('🔄 Stepper home (background)', 'debug'))
      .catch(err => log(`Stepper reset error: ${err.message}`, 'error'));

    trackCycleTime(cycleStartTime);
    resetInactivityTimer();

  } catch (error) {
    log(`Cycle error: ${error.message}`, 'error');
  }

  state.aiResult = null;
  state.weight = null;
  state.cycleInProgress = false;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  state.itemAlreadyPositioned = false;
  signalCycleComplete();

  if (state.autoCycleEnabled) {
    // Small delay so stepper starts moving before next weight check
    await delay(400);
    scheduleNextPhotoWithPositioning();
  }
}

// ============================================
// GATE HELPER (single close + one retry)
// ============================================
async function closeGateSafe() {
  log('🚪 Closing gate (safe)...', 'info');
  try {
    await executeCommand('closeGate');
    await delay(400);
    log('✅ Gate close confirmed', 'success');
  } catch (error) {
    log(`Gate close attempt 1 failed: ${error.message}`, 'error');
    try {
      await executeCommand('closeGate');
      await delay(300);
      log('✅ Gate close confirmed (retry)', 'success');
    } catch (_) {}
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
  
  log('🎬 Starting guest session', 'info');
  
  try {
    state.isReady = false;
    state.sessionId = sessionData.sessionId;
    state.sessionCode = sessionData.sessionCode;
    state.isGuestSession = true;
    state.autoCycleEnabled = true;
    state.itemsProcessed = 0;
    state.sessionStartTime = new Date();
    startSessionTimers();
    
    // ✅ SEQUENTIAL setup — all commands go through same serial bus
    // Parallel caused gate/motor commands to collide on WorldLucky middleware
    log('🔧 Initializing hardware (sequential)...', 'info');
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    log('✅ Belt stopped', 'debug');
    
    await stopCompactor();
    log('✅ Compactor stopped', 'debug');
    
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.resetHomeDelay);
    log('✅ Stepper homed', 'debug');
    
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationDelay);
    log('✅ Weight calibrated', 'debug');
    
    log('🚪 Opening gate...', 'info');
    await executeCommand('openGate');
    await delay(CONFIG.timing.commandDelay);
    log('✅ Gate opened', 'success');
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'session_active',
      message: 'Insert your items',
      sessionType: 'guest',
      timestamp: new Date().toISOString()
    }));
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'session_active',
      event: 'session_started',
      sessionType: 'guest',
      sessionId: state.sessionId,
      sessionCode: state.sessionCode,
      timestamp: new Date().toISOString()
    }));
    
    // Reduced from 4s to 2.5s
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
  
  // Gate close with retry
  await closeGateSafe();
  
  state.resetting = true;
  
  try {
    state.autoCycleEnabled = false;
    state.awaitingDetection = false;
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = null;
    }
    
    // Promise-based wait (was: blocking while-loop polling every 2s)
    if (state.cycleInProgress) {
      log('⏳ Waiting for current cycle to finish...', 'info');
      await waitForCycleComplete();
    }
    
    if (forceStop) {
      await stopCompactor();
    } else if (state.compactorRunning) {
      await delay(2000);
      await stopCompactor();
    }
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

  } catch (error) {
    log(`Reset error: ${error.message}`, 'error');
  } finally {
    try {
      if (state.sessionCode && state.itemsProcessed >= 0) {
        log(`📤 Notifying backend: Session ended (Code: ${state.sessionCode}, Items: ${state.itemsProcessed})`, 'info');
        
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: 'session_ended',
          event: 'session_ended',
          sessionCode: state.sessionCode,
          itemsProcessed: state.itemsProcessed,
          sessionType: 'guest',
          timestamp: new Date().toISOString()
        }));
        
        log('✅ Session end notification sent', 'success');
        await delay(1500);
      }
    } catch (error) {
      log(`⚠️ Session end notification error: ${error.message}`, 'warning');
    }
    
    state.aiResult = null;
    state.weight = null;
    state.sessionId = null;
    state.sessionCode = null;
    state.calibrationAttempts = 0;
    state.cycleInProgress = false;
    state.itemsProcessed = 0;
    state.sessionStartTime = null;
    state.detectionRetries = 0;
    state.isGuestSession = false;
    state.lastItemTime = null;
    state.itemAlreadyPositioned = false;
    
    clearSessionTimers();
    
    state.resetting = false;
    state.isReady = true;
    
    console.log('='.repeat(50));
    console.log('✅ READY FOR NEXT USER');
    console.log('='.repeat(50) + '\n');
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'ready',
      event: 'reset_complete',
      isReady: true,
      autoCycleEnabled: false,
      timestamp: new Date().toISOString()
    }));
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'waiting_for_guest',
      message: 'Press Start to begin',
      timestamp: new Date().toISOString()
    }));
    
    log('✅ System ready for next guest', 'success');
    log(`⏱️ Reset completed in ${Date.now() - resetStartTime}ms`, 'perf');
  }
}

// ============================================
// SESSION TIMERS
// ============================================
async function handleSessionTimeout(reason) {
  log(`⏱️ Session timeout: ${reason}`, 'warning');
  
  // Gate close with retry
  await closeGateSafe();
  
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  try {
    if (state.sessionCode && state.itemsProcessed >= 0) {
      mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
        deviceId: CONFIG.device.id,
        status: 'session_timeout',
        event: 'session_timeout',
        reason: reason,
        sessionCode: state.sessionCode,
        itemsProcessed: state.itemsProcessed,
        sessionType: 'guest',
        timestamp: new Date().toISOString()
      }));
      await delay(2000);
    }
  } catch (error) {
    // Ignore
  }
  
  // Promise-based wait (was: blocking while-loop)
  if (state.cycleInProgress) {
    await waitForCycleComplete();
  }
  
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
// MATERIAL TYPE DETECTION (unchanged from working version)
// ============================================
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase().trim();
  const probability = aiData.probability || 0;
  
  let materialType = 'UNKNOWN';
  let threshold = 1.0;
  let hasStrongKeyword = false;
  let detectionFormat = 'unknown';
  
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
  
  const confidencePercent = Math.round(probability * 100);
  
  if (probability < CONFIG.detection.minConfidenceRetry && materialType === 'UNKNOWN') return 'UNKNOWN';
  
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    const relaxedThreshold = detectionFormat === 'new_standard' ? threshold * 0.70 : threshold * 0.80;
    if (hasStrongKeyword && probability >= relaxedThreshold) {
      log(`🎯 ${materialType} detected (${confidencePercent}% - keyword match)`, 'detection');
      return materialType;
    }
    if (detectionFormat === 'new_standard' && probability >= 0.45) {
      log(`🎯 ${materialType} detected (${confidencePercent}% - standard format)`, 'detection');
      return materialType;
    }
    log(`❌ Low confidence: ${confidencePercent}%`, 'warning');
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') log(`✅ ${materialType} detected (${confidencePercent}%)`, 'detection');
  return materialType;
}

// ============================================
// HEALTH / DIAGNOSTICS
// ============================================
function checkSystemHealth() {
  const status = state.autoCycleEnabled ? 'ACTIVE' : 'IDLE';
  const compactor = state.compactorRunning ? 'ON' : 'OFF';
  log(`💓 System: ${status} | Compactor: ${compactor}`, 'info');
}

function runDiagnostics() {
  console.log('\n' + '='.repeat(60));
  console.log('🔬 SYSTEM DIAGNOSTICS - SPEED OPTIMIZED (GATE FIX)');
  console.log('='.repeat(60));
  
  console.log('\n👁️ Object Detection:');
  console.log(`   Sensor enabled: ❌ NO (DISABLED)`);
  console.log(`   Position before photo: ${CONFIG.detection.positionBeforePhoto ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`   Item positioned: ${state.itemAlreadyPositioned ? '✅ YES' : '❌ NO'}`);
  
  console.log('\n🔨 Compactor:');
  console.log(`   Running: ${state.compactorRunning ? '✅ YES' : '❌ NO'}`);
  console.log(`   Last item: ${state.lastItemTime ? Math.round((Date.now() - state.lastItemTime)/1000) + 's ago' : 'N/A'}`);
  console.log(`   Idle timer: ${state.compactorIdleTimer ? '⏰ ACTIVE' : '❌ NONE'}`);
  
  console.log('\n🗑️ Bin Status:');
  console.log(`   Plastic (Left): ${state.binStatus.plastic ? '❌ FULL' : '✅ OK'}`);
  console.log(`   Metal (Middle): ${state.binStatus.metal ? '❌ FULL' : '✅ OK'}`);
  console.log(`   Right Bin: ${state.binStatus.right ? '❌ FULL' : '✅ OK'}`);
  console.log(`   Glass: ${state.binStatus.glass ? '❌ FULL' : '✅ OK'}`);
  
  console.log('\n🎯 System:');
  console.log(`   deviceId: ${CONFIG.device.id}`);
  console.log(`   isReady: ${state.isReady}`);
  console.log(`   autoCycle: ${state.autoCycleEnabled}`);
  console.log(`   resetting: ${state.resetting}`);
  console.log(`   moduleId: ${state.moduleId}`);
  console.log(`   cycleInProgress: ${state.cycleInProgress}`);
  console.log(`   guestSession: ${state.isGuestSession}`);
  
  console.log('\n⏱️ Performance:');
  console.log(`   Last cycle: ${state.lastCycleTime || 'N/A'}ms`);
  console.log(`   Avg cycle: ${state.averageCycleTime ? Math.round(state.averageCycleTime) : 'N/A'}ms`);
  console.log(`   Total cycles: ${state.cycleCount}`);
  
  console.log('\n' + '='.repeat(60) + '\n');
  logDetectionStats();
}

// ============================================
// MQTT HEARTBEAT
// ============================================
const heartbeat = {
  interval: null,
  stateCheckInterval: null,
  timeout: CONFIG.heartbeat.interval,
  moduleIdRetries: 0,
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
          log('✅ System ready - Guest mode (Sensor disabled)', 'success');
          
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id, status: 'ready', event: 'startup_ready',
            moduleId: state.moduleId, isReady: true, mode: 'guest_only',
            sensorEnabled: false, timestamp
          }));
          
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id, state: 'waiting_for_guest',
            message: 'Press Start to begin', timestamp
          }));
          
          // Publish initial bin status
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId: CONFIG.device.id, binStatus: state.binStatus, timestamp
          }), { qos: 1, retain: true });
          
          log('📤 Initial bin status published', 'info');
        }
      }
    }
    
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) connectWebSocket();
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: state.isReady ? 'ready' : 'initializing',
      event: 'heartbeat', moduleId: state.moduleId, isReady: state.isReady,
      autoCycleEnabled: state.autoCycleEnabled, compactorRunning: state.compactorRunning,
      lastCycleTime: state.lastCycleTime,
      avgCycleTime: state.averageCycleTime ? Math.round(state.averageCycleTime) : null,
      detectionStats: state.detectionStats,
      mode: 'guest_only', sensorEnabled: false, timestamp
    }));
    
    const sessionStatus = state.autoCycleEnabled ? 'ACTIVE' : 'IDLE';
    const compactorStatus = state.compactorRunning ? '🔨' : '⚪';
    console.log(`💓 ${state.moduleId || 'WAIT'} | ${sessionStatus} | ${compactorStatus}`);
  }
};

// ============================================
// MODULE ID
// ============================================
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
  if (state.ws) {
    try { state.ws.removeAllListeners(); state.ws.close(); } catch (_) {}
    state.ws = null;
  }
  
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    log('✅ WebSocket connected', 'success');
    if (!state.moduleId) setTimeout(() => requestModuleId(), 1000);
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      // Module ID
      if (message.function === '01') {
        state.moduleId = message.moduleId;
        heartbeat.moduleIdRetries = 0;
        if (!state.isReady) {
          state.isReady = true;
          log('✅ System ready - Guest mode (Sensor disabled)', 'success');
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id, status: 'ready', moduleId: state.moduleId,
            isReady: true, mode: 'guest_only', sensorEnabled: false,
            timestamp: new Date().toISOString()
          }));
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id, state: 'waiting_for_guest',
            message: 'Press Start to begin', timestamp: new Date().toISOString()
          }));
        }
        return;
      }
      
      // AI Photo result
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
          log('🔍 AI detection complete - measuring weight...', 'detection');
          setTimeout(() => executeCommand('getWeight'), 300);
        }
        return;
      }
      
      // Bin status
      if (message.function === 'deviceStatus') {
        const binCode = parseInt(message.data);
        const binStatusMap = {
          0: { name: 'Plastic (PET)', key: 'plastic', critical: true },
          1: { name: 'Metal Can', key: 'metal', critical: true },
          2: { name: 'Right Bin', key: 'right', critical: false },
          3: { name: 'Glass', key: 'glass', critical: false },
          4: { name: 'Infrared Sensor', key: null, critical: false, isObjectSensor: true }
        };
        
        const binInfo = binStatusMap[binCode];
        if (!binInfo || binInfo.isObjectSensor) return;
        
        log(`⚠️ ${binInfo.name} bin full`, 'warning');
        if (binInfo.key) state.binStatus[binInfo.key] = true;
        
        mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
          deviceId: CONFIG.device.id, binCode, binName: binInfo.name,
          binKey: binInfo.key, isFull: true, critical: binInfo.critical,
          binStatus: state.binStatus, timestamp: new Date().toISOString()
        }), { qos: 1, retain: true });
        
        mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
          deviceId: CONFIG.device.id, state: 'bin_full_warning',
          message: `${binInfo.name} bin is full`, binCode,
          timestamp: new Date().toISOString()
        }));
        
        if (binInfo.critical && state.autoCycleEnabled) {
          const currentMaterialBin = state.aiResult?.materialType === 'METAL_CAN' ? 'metal' : 'plastic';
          if (binInfo.key === currentMaterialBin) {
            setTimeout(() => handleSessionTimeout('bin_full'), 2000);
          }
        }
        return;
      }
      
      // Weight result
      if (message.function === '06') {
        const weightValue = parseFloat(message.data) || 0;
        const coefficient = CONFIG.weight.coefficients[1];
        const calibratedWeight = weightValue * (coefficient / 1000);
        
        state.weight = {
          weight: Math.round(calibratedWeight * 10) / 10,
          rawWeight: weightValue, coefficient,
          timestamp: new Date().toISOString()
        };
        
        mqttClient.publish(CONFIG.mqtt.topics.weightResult, JSON.stringify(state.weight));
        
        if (state.aiResult && state.autoCycleEnabled && !state.cycleInProgress) {
          log(`⚖️ Final weight: ${state.weight.weight}g`, 'info');
          
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
            log('⚠️ Weight too low after photo - skipping', 'warning');
            state.aiResult = null;
            state.weight = null;
            state.itemAlreadyPositioned = false;
            scheduleNextPhotoWithPositioning();
            return;
          }
          
          if (state.aiResult.materialType === 'UNKNOWN') {
            log('❌ Unknown material - rejecting', 'warning');
            state.cycleInProgress = true;
            setTimeout(() => executeRejectionCycle(), 500);
            return;
          }
          
          log('✅ Starting auto cycle...', 'success');
          state.cycleInProgress = true;
          setTimeout(() => executeAutoCycle(), 500);
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
// MQTT CONNECTION & COMMANDS
// ============================================
const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
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
    isReady: true, mode: 'guest_only', sensorEnabled: false,
    timestamp: new Date().toISOString()
  }));
  
  connectWebSocket();
  setTimeout(() => requestModuleId(), 2000);
  setTimeout(() => heartbeat.start(), 5000);
});

mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());
    
    if (topic === CONFIG.mqtt.topics.guestStart) {
      if (state.resetting || !state.isReady) {
        log('System not ready for guest session', 'warning');
        return;
      }
      if (state.autoCycleEnabled) {
        log('Session already active - resetting first', 'info');
        await resetSystemForNextUser(false);
        await delay(2000);
      }
      await startGuestSession(payload);
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.commands) {
      
      if (payload.action === 'getBinStatus') {
        log('📊 Bin status requested', 'info');
        mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
          deviceId: CONFIG.device.id, binStatus: state.binStatus,
          timestamp: new Date().toISOString()
        }), { qos: 1, retain: true });
        return;
      }
      
      if (payload.action === 'resetBinStatus') {
        log('🗑️ Resetting bin status', 'info');
        const params = payload.params || {};
        if (params.resetAll) {
          state.binStatus.plastic = false;
          state.binStatus.metal = false;
          state.binStatus.right = false;
          state.binStatus.glass = false;
          log('✅ All bins reset', 'success');
        } else if (params.binCode !== undefined) {
          const binMap = { 0: 'plastic', 1: 'metal', 2: 'right', 3: 'glass' };
          const binKey = binMap[params.binCode];
          if (binKey) { state.binStatus[binKey] = false; log(`✅ ${binKey} bin reset`, 'success'); }
        }
        mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
          deviceId: CONFIG.device.id, action: 'reset', binStatus: state.binStatus,
          timestamp: new Date().toISOString()
        }), { qos: 1, retain: true });
        return;
      }
      
      if (payload.action === 'testBinFull') {
        const binCode = payload.params?.binCode || 0;
        const binStatusMap = {
          0: { name: 'Plastic (PET)', key: 'plastic' },
          1: { name: 'Metal Can', key: 'metal' }
        };
        const binInfo = binStatusMap[binCode];
        if (binInfo && binInfo.key) {
          state.binStatus[binInfo.key] = true;
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId: CONFIG.device.id, binCode, binName: binInfo.name,
            binKey: binInfo.key, isFull: true, binStatus: state.binStatus,
            timestamp: new Date().toISOString()
          }), { qos: 1, retain: true });
          log(`🧪 TEST: Marked ${binInfo.name} bin as full`, 'warning');
        }
        return;
      }
      
      if (payload.action === 'getStatus') {
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: state.isReady ? 'ready' : 'initializing',
          event: 'status_response', isReady: state.isReady,
          autoCycleEnabled: state.autoCycleEnabled, resetting: state.resetting,
          compactorRunning: state.compactorRunning, moduleId: state.moduleId,
          detectionStats: state.detectionStats,
          avgCycleTime: state.averageCycleTime ? Math.round(state.averageCycleTime) : null,
          mode: 'guest_only', sensorEnabled: false,
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (payload.action === 'getDetectionStats') { logDetectionStats(); return; }
      
      if (payload.action === 'emergencyStop') {
        // Sequential emergency stop — serial bus safety
        await executeCommand('closeGate');
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        await stopCompactor();
        state.autoCycleEnabled = false;
        state.cycleInProgress = false;
        state.resetting = false;
        state.isReady = false;
        return;
      }
      
      if (payload.action === 'forceReset') {
        state.cycleInProgress = false;
        state.resetting = false;
        await resetSystemForNextUser(true);
        return;
      }
      
      if (payload.action === 'endSession') {
        console.log('\n' + '🚨'.repeat(25));
        console.log('🛑 END SESSION COMMAND RECEIVED');
        console.log('🚨'.repeat(25) + '\n');
        
        state.autoCycleEnabled = false;
        state.awaitingDetection = false;
        
        if (state.autoPhotoTimer) {
          clearTimeout(state.autoPhotoTimer);
          state.autoPhotoTimer = null;
        }
        
        // Gate close with retry
        await closeGateSafe();
        
        console.log('✅ Gate closing commands sent - proceeding with reset\n');
        
        state.resetting = false;
        await resetSystemForNextUser(false);
        return;
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
  heartbeat.stop();
  stopCompactor();
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
process.on('uncaughtException', (error) => { log(`Uncaught exception: ${error.message}`, 'error'); console.error(error); gracefulShutdown(); });
process.on('unhandledRejection', (error) => { log(`Unhandled rejection: ${error.message}`, 'error'); console.error(error); });

// ============================================
// STARTUP
// ============================================
console.log('='.repeat(50));
console.log('🚀 RVM AGENT - SPEED OPTIMIZED (GATE FIX)');
console.log('='.repeat(50));
console.log(`Device: ${CONFIG.device.id}`);
console.log(`Config: ${machineConfigPath}`);
console.log('Mode: Guest users only');
console.log('Object Sensor: DISABLED');
console.log('Optimizations:');
console.log('  ⚡ Belt + stepper PARALLEL in cycle (diff moduleIds)');
console.log('  ⚡ Stepper home NON-BLOCKING');
console.log('  ⚡ Compactor fire-and-forget');
console.log('  ⚡ Reduced timing constants');
console.log('  ✅ Session startup SEQUENTIAL (serial bus safety)');
console.log('  ✅ Gate logging restored');
console.log('  ✅ Built-in photo/weight delays restored');
console.log('='.repeat(50) + '\n');