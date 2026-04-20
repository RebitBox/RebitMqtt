// agent-guest-optimized.js - SPEED OPTIMIZED VERSION
// Key changes:
//   1. Parallel motor operations where hardware allows
//   2. Eliminated redundant belt stops and double gate closes
//   3. Compactor runs fire-and-forget (not blocking cycle)
//   4. Removed double delays in executeCommand
//   5. Promise-based cycle wait instead of polling
//   6. Reduced initial session wait from 4s to 2s
//   7. Stepper pre-positioning during belt movement
//   8. Cleaner state machine with less redundancy

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  device: {
    id: 'RVM-3101'
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
      commands: 'rvm/RVM-3101/commands',
      autoControl: 'rvm/RVM-3101/control/auto',
      cycleComplete: 'rvm/RVM-3101/cycle/complete',
      aiResult: 'rvm/RVM-3101/ai/result',
      weightResult: 'rvm/RVM-3101/weight/result',
      status: 'rvm/RVM-3101/status',
      screenState: 'rvm/RVM-3101/screen/state',
      guestStart: 'rvm/RVM-3101/guest/start',
      binStatus: 'rvm/RVM-3101/bin/status'
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

  // ✅ OPTIMIZED TIMINGS - reduced where safe
  timing: {
    beltToWeight: 1800,
    beltToStepper: 2200,
    beltReverse: 3500,
    stepperRotate: 2200,
    stepperReset: 3000,
    compactorIdleStop: 8000,
    positionSettle: 150,          // was 200 - belt settles fast
    gateOperation: 600,
    sessionTimeout: 300000,
    sessionMaxDuration: 600000,
    weightDelay: 400,             // was 600 - sensor responds faster
    photoDelay: 400,              // was 600 - camera is fast
    calibrationDelay: 600,        // was 800
    commandDelay: 50,             // was 100
    resetHomeDelay: 800,          // was 1000
    itemDropDelay: 200,           // was 300
    photoPositionDelay: 100,
    initialItemWait: 2000,        // was 4000 - user already pressed start
    gateCloseWait: 300,           // single gate close wait
    cycleWaitPoll: 500,           // was 2000 for cycle completion polling
    maxCycleWait: 30000           // was 60000 - fail faster
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
  
  // ✅ Promise-based cycle completion signal
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
  log(`⏱️ Cycle time: ${cycleTime}ms (avg: ${Math.round(state.averageCycleTime)}ms)`, 'perf');
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
  if (successfulAttempts > 0) {
    state.detectionStats.averageRetries = totalRetries / successfulAttempts;
  }
  
  if (state.detectionStats.totalAttempts % 10 === 0) logDetectionStats();
}

function logDetectionStats() {
  const s = state.detectionStats;
  const total = s.firstTimeSuccess + s.secondTimeSuccess + s.thirdTimeSuccess + s.failures;
  if (total === 0) return;
  log(`📊 Detection: ${s.totalAttempts} total | ${((s.firstTimeSuccess / total) * 100).toFixed(1)}% first-time | Avg retries: ${s.averageRetries.toFixed(2)}`, 'detection');
}

// ✅ Promise-based wait for cycle completion (replaces polling while-loop)
function waitForCycleComplete(timeoutMs = CONFIG.timing.maxCycleWait) {
  if (!state.cycleInProgress) return Promise.resolve();
  
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.cycleCompleteResolve = null;
      log('⚠️ Cycle wait timed out', 'warning');
      resolve();
    }, timeoutMs);
    
    state.cycleCompleteResolve = () => {
      clearTimeout(timer);
      state.cycleCompleteResolve = null;
      resolve();
    };
  });
}

function signalCycleComplete() {
  if (state.cycleCompleteResolve) {
    state.cycleCompleteResolve();
  }
}

// ============================================
// COMPACTOR (fire-and-forget from cycle path)
// ============================================

function startCompactorAsync() {
  // ✅ Non-blocking - don't await in the cycle critical path
  if (state.compactorIdleTimer) {
    clearTimeout(state.compactorIdleTimer);
    state.compactorIdleTimer = null;
  }
  
  if (state.compactorRunning) {
    resetCompactorIdleTimer();
    return;
  }
  
  // Fire and forget
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
  if (state.compactorIdleTimer) {
    clearTimeout(state.compactorIdleTimer);
    state.compactorIdleTimer = null;
  }
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
  
  // ✅ REMOVED: built-in photoDelay/weightDelay from here
  // Those delays are only needed when waiting for WebSocket response,
  // which is handled by the caller where needed
  await axios.post(apiUrl, apiPayload, {
    timeout: CONFIG.local.timeout,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ============================================
// PHOTO DETECTION (OPTIMIZED - fewer belt stops)
// ============================================

async function scheduleNextPhotoWithPositioning() {
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  
  state.autoPhotoTimer = setTimeout(async () => {
    if (!state.autoCycleEnabled || state.cycleInProgress || state.awaitingDetection) return;
    
    // ✅ Single belt stop before weight check (was 3 stops)
    try {
      await executeCommand('customMotor', CONFIG.motors.belt.stop);
      await delay(CONFIG.timing.positionSettle);
    } catch (error) {
      log(`Belt pre-stop error: ${error.message}`, 'error');
    }
    
    // Weight check for item presence
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
        // ✅ Belt is already stopped from above - no need to stop again
        log('🔄 Moving belt to camera position...', 'info');
        
        await executeCommand('customMotor', CONFIG.motors.belt.toWeight);
        await delay(CONFIG.timing.beltToWeight);
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        await delay(CONFIG.timing.positionSettle);
        
        state.itemAlreadyPositioned = true;
        log('✅ Item positioned - taking photo', 'camera');
      }
      
      await executeCommand('takePhoto');
      await delay(CONFIG.timing.photoDelay);
      log('📸 Photo sent - waiting for AI result...', 'camera');
      
    } catch (error) {
      log(`❌ Photo positioning error: ${error.message}`, 'error');
      state.awaitingDetection = false;
      state.itemAlreadyPositioned = false;
      state.weight = null;
      
      try { await executeCommand('customMotor', CONFIG.motors.belt.stop); } catch (_) {}
      
      if (state.autoCycleEnabled) scheduleNextPhotoWithPositioning();
    }
  }, 500);
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

    mqttClient.publish('rvm/RVM-3101/item/rejected', JSON.stringify({
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
// AUTO CYCLE (OPTIMIZED - parallel operations)
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

  try {
    // ✅ OPTIMIZATION 1: Start compactor non-blocking
    startCompactorAsync();
    
    // ✅ OPTIMIZATION 2: Pre-position stepper WHILE belt is moving
    const targetPosition = material === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    // Start belt and stepper simultaneously
    // Belt moves item toward stepper area while stepper rotates to target
    log('🔄 Belt to stepper + stepper pre-position (parallel)', 'perf');
    
    const beltPromise = (async () => {
      await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
      await delay(CONFIG.timing.beltToStepper);
      await executeCommand('customMotor', CONFIG.motors.belt.stop);
    })();
    
    const stepperPromise = (async () => {
      await executeCommand('stepperMotor', { position: targetPosition });
      await delay(CONFIG.timing.stepperRotate);
    })();
    
    // Wait for both to complete
    await Promise.all([beltPromise, stepperPromise]);
    
    // Item drops
    await delay(CONFIG.timing.itemDropDelay);
    
    // ✅ OPTIMIZATION 3: Reset stepper without blocking next photo
    // Start stepper reset, but don't wait full duration before scheduling next
    executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home })
      .then(() => delay(CONFIG.timing.stepperReset))
      .then(() => log('🔄 Stepper returned home', 'debug'))
      .catch(err => log(`Stepper reset error: ${err.message}`, 'error'));

    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));
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
    // ✅ Small delay to let stepper start moving before next weight check
    await delay(500);
    scheduleNextPhotoWithPositioning();
  }
}

// ============================================
// GATE HELPER (single close with one retry)
// ============================================
async function closeGateSafe() {
  try {
    await executeCommand('closeGate');
    await delay(CONFIG.timing.gateCloseWait);
    log('✅ Gate closed', 'success');
  } catch (error) {
    log(`Gate close attempt 1 failed: ${error.message}`, 'error');
    // One retry
    try {
      await executeCommand('closeGate');
      await delay(CONFIG.timing.gateCloseWait);
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
  
  try {
    state.isReady = false;
    state.sessionId = sessionData.sessionId;
    state.sessionCode = sessionData.sessionCode;
    state.isGuestSession = true;
    state.autoCycleEnabled = true;
    state.itemsProcessed = 0;
    state.sessionStartTime = new Date();
    startSessionTimers();
    
    // ✅ Parallel: stop belt + stop compactor + reset stepper
    await Promise.all([
      executeCommand('customMotor', CONFIG.motors.belt.stop),
      stopCompactor(),
      (async () => {
        await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
        await delay(CONFIG.timing.resetHomeDelay);
      })()
    ]);
    
    // Calibrate weight then open gate
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationDelay);
    
    await executeCommand('openGate');
    await delay(CONFIG.timing.commandDelay);
    
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
    
    // ✅ Reduced from 4s to 2s - user already pressed start
    log(`⏳ Waiting ${CONFIG.timing.initialItemWait}ms for first item...`, 'info');
    await delay(CONFIG.timing.initialItemWait);
    
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
  
  // ✅ Single gate close (was 2 attempts with 700ms total)
  await closeGateSafe();
  
  state.resetting = true;
  
  try {
    state.autoCycleEnabled = false;
    state.awaitingDetection = false;
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = null;
    }
    
    // ✅ Promise-based wait instead of polling while-loop
    if (state.cycleInProgress) {
      log('⏳ Waiting for current cycle to finish...', 'info');
      await waitForCycleComplete();
    }
    
    if (forceStop) {
      await stopCompactor();
    } else if (state.compactorRunning) {
      await delay(1500);
      await stopCompactor();
    }
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

  } catch (error) {
    log(`Reset error: ${error.message}`, 'error');
  } finally {
    // Notify backend of session end
    try {
      if (state.sessionCode) {
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
        await delay(1000);
      }
    } catch (error) {
      log(`⚠️ Session end notification error: ${error.message}`, 'warning');
    }
    
    // Clear all state
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
    
    log(`⏱️ Reset completed in ${Date.now() - resetStartTime}ms`, 'perf');
  }
}

// ============================================
// SESSION TIMERS
// ============================================
async function handleSessionTimeout(reason) {
  log(`⏱️ Session timeout: ${reason}`, 'warning');
  
  // ✅ Single gate close (was 2 attempts)
  await closeGateSafe();
  
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  try {
    if (state.sessionCode) {
      mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
        deviceId: CONFIG.device.id,
        status: 'session_timeout',
        event: 'session_timeout',
        reason,
        sessionCode: state.sessionCode,
        itemsProcessed: state.itemsProcessed,
        sessionType: 'guest',
        timestamp: new Date().toISOString()
      }));
      await delay(1500);
    }
  } catch (_) {}
  
  // ✅ Promise-based wait instead of polling
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
// MATERIAL TYPE DETECTION (unchanged logic)
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
  
  if (probability < CONFIG.detection.minConfidenceRetry && materialType === 'UNKNOWN') return 'UNKNOWN';
  
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    const relaxedThreshold = detectionFormat === 'new_standard' ? threshold * 0.70 : threshold * 0.80;
    if (hasStrongKeyword && probability >= relaxedThreshold) {
      log(`🎯 ${materialType} (${Math.round(probability * 100)}% - keyword)`, 'detection');
      return materialType;
    }
    if (detectionFormat === 'new_standard' && probability >= 0.45) {
      log(`🎯 ${materialType} (${Math.round(probability * 100)}% - standard)`, 'detection');
      return materialType;
    }
    log(`❌ Low confidence: ${Math.round(probability * 100)}%`, 'warning');
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') {
    log(`✅ ${materialType} (${Math.round(probability * 100)}%)`, 'detection');
  }
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
  console.log('🔬 SYSTEM DIAGNOSTICS - GUEST MODE (OPTIMIZED)');
  console.log('='.repeat(60));
  console.log(`\n👁️ Sensor: DISABLED | Position before photo: ${CONFIG.detection.positionBeforePhoto ? '✅' : '❌'}`);
  console.log(`🔨 Compactor: ${state.compactorRunning ? '✅ ON' : '❌ OFF'} | Last item: ${state.lastItemTime ? Math.round((Date.now() - state.lastItemTime)/1000) + 's ago' : 'N/A'}`);
  console.log(`🗑️ Bins: PET=${state.binStatus.plastic?'FULL':'OK'} Metal=${state.binStatus.metal?'FULL':'OK'} Right=${state.binStatus.right?'FULL':'OK'} Glass=${state.binStatus.glass?'FULL':'OK'}`);
  console.log(`🎯 Ready:${state.isReady} Auto:${state.autoCycleEnabled} Reset:${state.resetting} Cycle:${state.cycleInProgress}`);
  console.log(`⏱️ Last cycle: ${state.lastCycleTime || 'N/A'}ms | Avg: ${state.averageCycleTime ? Math.round(state.averageCycleTime) : 'N/A'}ms`);
  console.log('='.repeat(60) + '\n');
  logDetectionStats();
}

// ============================================
// MQTT HEARTBEAT
// ============================================
const heartbeat = {
  interval: null,
  stateCheckInterval: null,
  moduleIdRetries: 0,
  
  start() {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this.beat(), CONFIG.heartbeat.interval * 1000);
    
    if (this.stateCheckInterval) clearInterval(this.stateCheckInterval);
    this.stateCheckInterval = setInterval(() => checkSystemHealth(), CONFIG.heartbeat.stateCheckInterval * 1000);
  },
  
  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.stateCheckInterval) { clearInterval(this.stateCheckInterval); this.stateCheckInterval = null; }
  },
  
  async beat() {
    const timestamp = new Date().toISOString();
    
    if (!state.moduleId && this.moduleIdRetries < CONFIG.heartbeat.maxModuleIdRetries) {
      this.moduleIdRetries++;
      await requestModuleId();
      await delay(1000);
      
      if (state.moduleId) {
        this.moduleIdRetries = 0;
        if (!state.isReady) {
          state.isReady = true;
          log('✅ System ready - Guest mode (Sensor disabled)', 'success');
          
          publishStatus('ready', 'startup_ready');
          
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id, state: 'waiting_for_guest',
            message: 'Press Start to begin', timestamp
          }));
          
          publishBinStatus();
        }
      }
    }
    
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) connectWebSocket();
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: state.isReady ? 'ready' : 'initializing',
      event: 'heartbeat',
      moduleId: state.moduleId,
      isReady: state.isReady,
      autoCycleEnabled: state.autoCycleEnabled,
      compactorRunning: state.compactorRunning,
      lastCycleTime: state.lastCycleTime,
      avgCycleTime: state.averageCycleTime ? Math.round(state.averageCycleTime) : null,
      detectionStats: state.detectionStats,
      mode: 'guest_only',
      sensorEnabled: false,
      timestamp
    }));
  }
};

// ============================================
// MQTT PUBLISH HELPERS
// ============================================
function publishStatus(status, event, extra = {}) {
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id, status, event,
    moduleId: state.moduleId, isReady: state.isReady,
    mode: 'guest_only', sensorEnabled: false,
    timestamp: new Date().toISOString(),
    ...extra
  }));
}

function publishBinStatus(extra = {}) {
  mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
    deviceId: CONFIG.device.id, binStatus: state.binStatus,
    timestamp: new Date().toISOString(), ...extra
  }), { qos: 1, retain: true });
}

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
      
      // Module ID response
      if (message.function === '01') {
        state.moduleId = message.moduleId;
        heartbeat.moduleIdRetries = 0;
        
        if (!state.isReady) {
          state.isReady = true;
          log('✅ System ready - Guest mode', 'success');
          publishStatus('ready', 'startup_ready');
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
          log('🔍 AI complete - measuring weight...', 'detection');
          // ✅ Reduced delay before weight command
          setTimeout(() => executeCommand('getWeight'), 200);
        }
        return;
      }
      
      // Bin status (deviceStatus)
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
        
        publishBinStatus({ binCode, binName: binInfo.name, binKey: binInfo.key, isFull: true, critical: binInfo.critical });
        
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
            log('⚠️ Weight too low - skipping', 'warning');
            state.aiResult = null;
            state.weight = null;
            state.itemAlreadyPositioned = false;
            scheduleNextPhotoWithPositioning();
            return;
          }
          
          if (state.aiResult.materialType === 'UNKNOWN') {
            log('❌ Unknown material - rejecting', 'warning');
            state.cycleInProgress = true;
            setTimeout(() => executeRejectionCycle(), 300);
            return;
          }
          
          log('✅ Starting auto cycle...', 'success');
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
// MQTT CONNECTION & COMMAND HANDLER
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
  
  publishStatus('ready', 'startup_ready');
  
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
        await delay(1500);
      }
      await startGuestSession(payload);
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.commands) {
      switch (payload.action) {
        case 'getBinStatus':
          log('📊 Bin status requested', 'info');
          publishBinStatus();
          return;
          
        case 'resetBinStatus': {
          log('🗑️ Resetting bin status', 'info');
          const params = payload.params || {};
          if (params.resetAll) {
            state.binStatus = { plastic: false, metal: false, right: false, glass: false };
            log('✅ All bins reset', 'success');
          } else if (params.binCode !== undefined) {
            const binKey = { 0: 'plastic', 1: 'metal', 2: 'right', 3: 'glass' }[params.binCode];
            if (binKey) { state.binStatus[binKey] = false; log(`✅ ${binKey} bin reset`, 'success'); }
          }
          publishBinStatus({ action: 'reset' });
          return;
        }
          
        case 'testBinFull': {
          const binCode = payload.params?.binCode || 0;
          const binInfo = { 0: { name: 'Plastic (PET)', key: 'plastic' }, 1: { name: 'Metal Can', key: 'metal' } }[binCode];
          if (binInfo?.key) {
            state.binStatus[binInfo.key] = true;
            publishBinStatus({ binCode, binName: binInfo.name, binKey: binInfo.key, isFull: true });
            log(`🧪 TEST: ${binInfo.name} marked full`, 'warning');
          }
          return;
        }
          
        case 'getStatus':
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status: state.isReady ? 'ready' : 'initializing',
            event: 'status_response',
            isReady: state.isReady, autoCycleEnabled: state.autoCycleEnabled,
            resetting: state.resetting, compactorRunning: state.compactorRunning,
            moduleId: state.moduleId, detectionStats: state.detectionStats,
            avgCycleTime: state.averageCycleTime ? Math.round(state.averageCycleTime) : null,
            mode: 'guest_only', sensorEnabled: false,
            timestamp: new Date().toISOString()
          }));
          return;
          
        case 'getDetectionStats':
          logDetectionStats();
          return;
          
        case 'emergencyStop':
          await Promise.all([
            executeCommand('closeGate').catch(() => {}),
            executeCommand('customMotor', CONFIG.motors.belt.stop).catch(() => {}),
            stopCompactor()
          ]);
          state.autoCycleEnabled = false;
          state.cycleInProgress = false;
          state.resetting = false;
          state.isReady = false;
          return;
          
        case 'forceReset':
          state.cycleInProgress = false;
          state.resetting = false;
          await resetSystemForNextUser(true);
          return;
          
        case 'endSession':
          console.log('\n🛑 END SESSION COMMAND RECEIVED\n');
          state.autoCycleEnabled = false;
          state.awaitingDetection = false;
          if (state.autoPhotoTimer) { clearTimeout(state.autoPhotoTimer); state.autoPhotoTimer = null; }
          await closeGateSafe();
          state.resetting = false;
          await resetSystemForNextUser(false);
          return;
          
        case 'runDiagnostics':
          runDiagnostics();
          return;
          
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
process.on('uncaughtException', (error) => { log(`Uncaught: ${error.message}`, 'error'); console.error(error); gracefulShutdown(); });
process.on('unhandledRejection', (error) => { log(`Unhandled: ${error.message}`, 'error'); console.error(error); });

// ============================================
// STARTUP
// ============================================
console.log('='.repeat(50));
console.log('🚀 RVM AGENT - GUEST MODE - SPEED OPTIMIZED');
console.log('='.repeat(50));
console.log(`Device: ${CONFIG.device.id}`);
console.log('Mode: Guest users only');
console.log('Optimizations: Parallel motors, reduced delays, non-blocking compactor');
console.log('='.repeat(50) + '\n');