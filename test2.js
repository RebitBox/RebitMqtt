// agent-guest-only.js - COMPLETE UPDATED VERSION WITH BIN STATUS FIX
// Object sensor DISABLED for immediate functionality
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

  timing: {
    beltToWeight: 1800,
    beltToStepper: 2200,
    beltReverse: 3500,
    stepperRotate: 2200,
    stepperReset: 3000,
    compactorIdleStop: 8000,
    positionSettle: 200,
    gateOperation: 600,
    autoPhotoDelay: 2500,
    sessionTimeout: 300000,
    sessionMaxDuration: 600000,
    weightDelay: 600,
    photoDelay: 600,
    calibrationDelay: 800,
    commandDelay: 100,
    resetHomeDelay: 1000,
    itemDropDelay: 300,
    photoPositionDelay: 100
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
    'info': 'ℹ️',
    'success': '✅',
    'error': '❌',
    'warning': '⚠️',
    'debug': '🔍',
    'perf': '⚡',
    'crusher': '🔨',
    'camera': '📸',
    'detection': '🎯'
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
    if (retryCount === 0) {
      state.detectionStats.firstTimeSuccess++;
    } else if (retryCount === 1) {
      state.detectionStats.secondTimeSuccess++;
    } else if (retryCount === 2) {
      state.detectionStats.thirdTimeSuccess++;
    }
    
    state.detectionStats.lastSuccessfulTiming = {
      retries: retryCount,
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
  
  if (state.detectionStats.totalAttempts % 10 === 0) {
    logDetectionStats();
  }
}

function logDetectionStats() {
  const stats = state.detectionStats;
  const total = stats.firstTimeSuccess + stats.secondTimeSuccess + stats.thirdTimeSuccess + stats.failures;
  
  if (total === 0) return;
  
  const firstTimeRate = ((stats.firstTimeSuccess / total) * 100).toFixed(1);
  
  log(`📊 Detection: ${stats.totalAttempts} total | ${firstTimeRate}% first-time | Avg retries: ${stats.averageRetries.toFixed(2)}`, 'detection');
}

// ============================================
// CONTINUOUS COMPACTOR MANAGEMENT
// ============================================

async function startContinuousCompactor() {
  if (state.compactorIdleTimer) {
    clearTimeout(state.compactorIdleTimer);
    state.compactorIdleTimer = null;
  }
  
  if (state.compactorRunning) {
    resetCompactorIdleTimer();
    return;
  }
  
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
  if (state.compactorIdleTimer) {
    clearTimeout(state.compactorIdleTimer);
  }
  
  state.lastItemTime = Date.now();
  
  state.compactorIdleTimer = setTimeout(async () => {
    if (state.compactorRunning && state.autoCycleEnabled) {
      log('🔨 No items detected - stopping compactor (idle)', 'crusher');
      await stopCompactor();
    }
  }, CONFIG.timing.compactorIdleStop);
}

async function stopCompactor() {
  if (!state.compactorRunning) {
    return;
  }
  
  try {
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    log('🔨 Compactor stopped', 'crusher');
  } catch (error) {
    log(`Compactor stop error: ${error.message}`, 'error');
  }
  
  state.compactorRunning = false;
  
  if (state.compactorTimer) {
    clearTimeout(state.compactorTimer);
    state.compactorTimer = null;
  }
  
  if (state.compactorIdleTimer) {
    clearTimeout(state.compactorIdleTimer);
    state.compactorIdleTimer = null;
  }
}

// ============================================
// PHOTO DETECTION WITH POSITIONING (NO SENSOR)
// ============================================

async function scheduleNextPhotoWithPositioning() {
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
  }
  
  state.autoPhotoTimer = setTimeout(async () => {
    if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
      
      try {
        await executeCommand('getWeight');
        await delay(CONFIG.timing.weightDelay);
        
        if (!state.weight || state.weight.weight < CONFIG.detection.minValidWeight) {
          state.weight = null;
          
          if (state.autoCycleEnabled) {
            await scheduleNextPhotoWithPositioning();
          }
          return;
        }
        
        log(`✅ Item detected (${state.weight.weight}g) - proceeding immediately`, 'success');
        
        state.weight = null;
        
      } catch (error) {
        log(`Weight check error: ${error.message}`, 'error');
        
        if (state.autoCycleEnabled) {
          await scheduleNextPhotoWithPositioning();
        }
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
          await delay(CONFIG.timing.photoPositionDelay);
          
          state.itemAlreadyPositioned = true;
          log('✅ Item positioned for photo', 'camera');
        }
        
        log('📸 Taking photo...', 'camera');
        await executeCommand('takePhoto');
        
      } catch (error) {
        log(`Photo positioning error: ${error.message}`, 'error');
        state.awaitingDetection = false;
        state.itemAlreadyPositioned = false;
        state.weight = null;
        
        if (state.autoCycleEnabled) {
          await scheduleNextPhotoWithPositioning();
        }
      }
    }
  }, 500);
}

// ============================================
// HEALTH CHECKS
// ============================================

function checkSystemHealth() {
  const status = state.autoCycleEnabled ? 'ACTIVE' : 'IDLE';
  const compactor = state.compactorRunning ? 'ON' : 'OFF';
  log(`💓 System: ${status} | Compactor: ${compactor}`, 'info');
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
    if (this.interval) {
      clearInterval(this.interval);
    }
    
    this.interval = setInterval(async () => {
      await this.beat();
    }, this.timeout * 1000);
    
    if (this.stateCheckInterval) {
      clearInterval(this.stateCheckInterval);
    }
    
    this.stateCheckInterval = setInterval(() => {
      checkSystemHealth();
    }, CONFIG.heartbeat.stateCheckInterval * 1000);
  },
  
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    if (this.stateCheckInterval) {
      clearInterval(this.stateCheckInterval);
      this.stateCheckInterval = null;
    }
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
            deviceId: CONFIG.device.id,
            status: 'ready',
            event: 'startup_ready',
            moduleId: state.moduleId,
            isReady: true,
            mode: 'guest_only',
            sensorEnabled: false,
            timestamp
          }));
          
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id,
            state: 'waiting_for_guest',
            message: 'Press Start to begin',
            timestamp
          }));
          
          // ✅ PUBLISH INITIAL BIN STATUS
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId: CONFIG.device.id,
            binStatus: state.binStatus,
            timestamp
          }), { 
            qos: 1, 
            retain: true 
          });
          
          log('📤 Initial bin status published', 'info');
        }
      }
    }
    
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: state.isReady ? 'ready' : 'initializing',
      event: 'heartbeat',
      moduleId: state.moduleId,
      isReady: state.isReady,
      autoCycleEnabled: state.autoCycleEnabled,
      compactorRunning: state.compactorRunning,
      lastCycleTime: state.lastCycleTime,
      detectionStats: state.detectionStats,
      mode: 'guest_only',
      sensorEnabled: false,
      timestamp
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
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('❌ Module ID request failed:', error.message);
  }
}

// ============================================
// DIAGNOSTICS
// ============================================
function runDiagnostics() {
  console.log('\n' + '='.repeat(60));
  console.log('🔬 SYSTEM DIAGNOSTICS - GUEST MODE');
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
  console.log(`   isReady: ${state.isReady}`);
  console.log(`   autoCycle: ${state.autoCycleEnabled}`);
  console.log(`   resetting: ${state.resetting}`);
  console.log(`   moduleId: ${state.moduleId}`);
  console.log(`   cycleInProgress: ${state.cycleInProgress}`);
  console.log(`   guestSession: ${state.isGuestSession}`);
  
  console.log('\n' + '='.repeat(60) + '\n');
  
  logDetectionStats();
}

// ============================================
// MATERIAL TYPE DETECTION
// ============================================
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase().trim();
  const probability = aiData.probability || 0;
  
  let materialType = 'UNKNOWN';
  let threshold = 1.0;
  let hasStrongKeyword = false;
  let detectionFormat = 'unknown';
  
  if (className === '0-pet' || className.startsWith('0-pet')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = true;
    detectionFormat = 'new_standard';
  } 
  else if (className === '1-can' || className.startsWith('1-can')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = true;
    detectionFormat = 'new_standard';
  }
  else if (/^0[-_\s]*(pet|plastic|bottle)/i.test(className)) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = true;
    detectionFormat = 'variant_format';
  }
  else if (/^1[-_\s]*(can|metal|aluminum)/i.test(className)) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = true;
    detectionFormat = 'variant_format';
  }
  else if (className.includes('易拉罐') || className.includes('铝')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = true;
    detectionFormat = 'legacy_chinese';
  } 
  else if (className.includes('pet') || className.includes('瓶')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = className.includes('pet');
    detectionFormat = 'legacy_keyword';
  }
  else if (className.includes('metal') || className.includes('can')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = false;
    detectionFormat = 'legacy_keyword';
  } 
  else if (className.includes('plastic') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = false;
    detectionFormat = 'legacy_keyword';
  } 
  else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS';
    threshold = CONFIG.detection.GLASS;
    hasStrongKeyword = className.includes('玻璃');
    detectionFormat = 'glass_detected';
  }
  
  const confidencePercent = Math.round(probability * 100);
  
  if (probability < CONFIG.detection.minConfidenceRetry && materialType === 'UNKNOWN') {
    return 'UNKNOWN';
  }
  
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
  
  if (materialType !== 'UNKNOWN') {
    log(`✅ ${materialType} detected (${confidencePercent}%)`, 'detection');
  }
  
  return materialType;
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
      apiPayload = {
        moduleId: CONFIG.motors.stepper.moduleId,
        id: params.position,
        type: params.position,
        deviceType
      };
      break;
      
    case 'customMotor':
      apiUrl = `${CONFIG.local.baseUrl}/system/serial/motorSelect`;
      apiPayload = {
        moduleId: state.moduleId,
        motorId: params.motorId,
        type: params.type,
        deviceType
      };
      break;
      
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

  if (state.autoCycleEnabled) {
    await scheduleNextPhotoWithPositioning();
  }
}

// ============================================
// AUTO CYCLE
// ============================================
async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    state.cycleInProgress = false;
    return;
  }

  const cycleStartTime = Date.now();
  state.itemsProcessed++;
  
  trackDetectionAttempt(true, state.detectionRetries);
  
  if (state.itemAlreadyPositioned && state.detectionRetries > 0) {
    state.detectionStats.positioningHelped++;
  }
  
  const cycleData = {
    deviceId: CONFIG.device.id,
    material: state.aiResult.materialType,
    weight: state.weight.weight,
    sessionCode: state.sessionCode,
    itemNumber: state.itemsProcessed,
    detectionRetries: state.detectionRetries,
    itemWasPositioned: state.itemAlreadyPositioned,
    timestamp: new Date().toISOString()
  };
  
  log(`⚡ Item #${state.itemsProcessed}: ${cycleData.material} (${cycleData.weight}g)`, 'success');

  try {
    await startContinuousCompactor();
    
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    const targetPosition = cycleData.material === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    await executeCommand('stepperMotor', { position: targetPosition });
    await delay(CONFIG.timing.stepperRotate);

    await delay(CONFIG.timing.itemDropDelay);

    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);

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

  if (state.autoCycleEnabled) {
    await scheduleNextPhotoWithPositioning();
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
    
    log('⏳ Waiting 4 seconds for first item...', 'info');
    await delay(4000);
    
    await scheduleNextPhotoWithPositioning();
    
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
  } catch (error) {
    // Ignore
  }
  
  state.resetting = true;
  
  try {
    state.autoCycleEnabled = false;
    state.awaitingDetection = false;
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = null;
    }
    
    if (state.cycleInProgress) {
      const maxWait = 60000;
      const startWait = Date.now();
      
      while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
        await delay(2000);
      }
    }
    
    if (forceStop) {
      await stopCompactor();
    } else {
      if (state.compactorRunning) {
        await delay(2000);
        await stopCompactor();
      }
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
    
    const resetDuration = Date.now() - resetStartTime;
    log(`⏱️ Reset completed in ${resetDuration}ms`, 'perf');
  }
}

// ============================================
// SESSION TIMERS
// ============================================

async function handleSessionTimeout(reason) {
  log(`⏱️ Session timeout: ${reason}`, 'warning');
  
  log('🚪 Closing gate immediately (timeout)', 'warning');
  try {
    await executeCommand('closeGate');
    await delay(400);
    log('✅ Gate closed on timeout', 'success');
  } catch (error) {
    log(`❌ Gate close error: ${error.message}`, 'error');
  }
  
  try {
    await executeCommand('closeGate');
    await delay(300);
    log('✅ Gate close confirmed (second attempt)', 'success');
  } catch (error) {
    // Ignore
  }
  
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
  
  if (state.cycleInProgress) {
    const maxWait = 60000;
    const startWait = Date.now();
    
    while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
      await delay(1000);
    }
  }
  
  state.resetting = false;
  
  await resetSystemForNextUser(false);
}

function resetInactivityTimer() {
  if (state.sessionTimeoutTimer) {
    clearTimeout(state.sessionTimeoutTimer);
  }
  
  state.lastActivityTime = Date.now();
  
  state.sessionTimeoutTimer = setTimeout(() => {
    handleSessionTimeout('inactivity');
  }, CONFIG.timing.sessionTimeout);
}

function startSessionTimers() {
  resetInactivityTimer();
  
  if (state.maxDurationTimer) {
    clearTimeout(state.maxDurationTimer);
  }
  
  state.maxDurationTimer = setTimeout(() => {
    handleSessionTimeout('max_duration');
  }, CONFIG.timing.sessionMaxDuration);
}

function clearSessionTimers() {
  if (state.sessionTimeoutTimer) {
    clearTimeout(state.sessionTimeoutTimer);
    state.sessionTimeoutTimer = null;
  }
  
  if (state.maxDurationTimer) {
    clearTimeout(state.maxDurationTimer);
    state.maxDurationTimer = null;
  }
}

// ============================================
// WEBSOCKET
// ============================================
function connectWebSocket() {
  if (state.ws) {
    try {
      state.ws.removeAllListeners();
      state.ws.close();
    } catch (e) {
      // Ignore
    }
    state.ws = null;
  }
  
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    log('✅ WebSocket connected', 'success');
    
    if (!state.moduleId) {
      setTimeout(() => requestModuleId(), 1000);
    }
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.function === '01') {
        state.moduleId = message.moduleId;
        heartbeat.moduleIdRetries = 0;
        
        if (!state.isReady) {
          state.isReady = true;
          log('✅ System ready - Guest mode (Sensor disabled)', 'success');
          
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status: 'ready',
            moduleId: state.moduleId,
            isReady: true,
            mode: 'guest_only',
            sensorEnabled: false,
            timestamp: new Date().toISOString()
          }));
          
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id,
            state: 'waiting_for_guest',
            message: 'Press Start to begin',
            timestamp: new Date().toISOString()
          }));
        }
        
        return;
      }
      
      if (message.function === 'aiPhoto') {
        const aiData = JSON.parse(message.data);
        const materialType = determineMaterialType(aiData);
        
        state.aiResult = {
          matchRate: Math.round((aiData.probability || 0) * 100),
          materialType: materialType,
          className: aiData.className,
          taskId: aiData.taskId,
          timestamp: new Date().toISOString()
        };
        
        mqttClient.publish(CONFIG.mqtt.topics.aiResult, JSON.stringify(state.aiResult));
        
        if (state.autoCycleEnabled && state.awaitingDetection) {
          state.awaitingDetection = false;
          log('🔍 AI detection complete - measuring weight...', 'detection');
          setTimeout(() => executeCommand('getWeight'), 300);
        }
        return;
      }
      
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
        
        if (binInfo) {
          if (binInfo.isObjectSensor) {
            return;
          }
          
          log(`⚠️ ${binInfo.name} bin full`, 'warning');
          
          if (binInfo.key) {
            state.binStatus[binInfo.key] = true;
          }
          
          // ✅ PUBLISH WITH RETAIN FLAG
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId: CONFIG.device.id,
            binCode: binCode,
            binName: binInfo.name,
            binKey: binInfo.key,
            isFull: true,
            critical: binInfo.critical,
            binStatus: state.binStatus,
            timestamp: new Date().toISOString()
          }), { 
            qos: 1,
            retain: true
          });
          
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id,
            state: 'bin_full_warning',
            message: `${binInfo.name} bin is full`,
            binCode: binCode,
            timestamp: new Date().toISOString()
          }));
          
          if (binInfo.critical && state.autoCycleEnabled) {
            const currentMaterialBin = state.aiResult?.materialType === 'METAL_CAN' ? 'metal' : 'plastic';
            
            if (binInfo.key === currentMaterialBin) {
              setTimeout(async () => {
                await handleSessionTimeout('bin_full');
              }, 2000);
            }
          }
        }
        
        return;
      }
      
      if (message.function === '06') {
        const weightValue = parseFloat(message.data) || 0;
        const coefficient = CONFIG.weight.coefficients[1];
        const calibratedWeight = weightValue * (coefficient / 1000);
        
        state.weight = {
          weight: Math.round(calibratedWeight * 10) / 10,
          rawWeight: weightValue,
          coefficient: coefficient,
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
            
            await scheduleNextPhotoWithPositioning();
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
  
  state.ws.on('error', (error) => {
    log(`WS error: ${error.message}`, 'error');
  });
  
  state.ws.on('close', () => {
    setTimeout(() => connectWebSocket(), 5000);
  });
}

// ============================================
// MQTT
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
    deviceId: CONFIG.device.id,
    status: 'online',
    event: 'device_connected',
    mode: 'guest_only',
    sensorEnabled: false,
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'ready',
    event: 'startup_ready',
    isReady: true,
    mode: 'guest_only',
    sensorEnabled: false,
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
      
      // ✅ NEW: getBinStatus command
      if (payload.action === 'getBinStatus') {
        log('📊 Bin status requested', 'info');
        
        mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
          deviceId: CONFIG.device.id,
          binStatus: state.binStatus,
          timestamp: new Date().toISOString()
        }), { 
          qos: 1, 
          retain: true 
        });
        
        return;
      }
      
      // ✅ NEW: resetBinStatus command
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
          
          if (binKey) {
            state.binStatus[binKey] = false;
            log(`✅ ${binKey} bin reset`, 'success');
          }
        }
        
        mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
          deviceId: CONFIG.device.id,
          action: 'reset',
          binStatus: state.binStatus,
          timestamp: new Date().toISOString()
        }), { 
          qos: 1, 
          retain: true 
        });
        
        return;
      }
      
      // ✅ NEW: testBinFull command
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
            deviceId: CONFIG.device.id,
            binCode: binCode,
            binName: binInfo.name,
            binKey: binInfo.key,
            isFull: true,
            binStatus: state.binStatus,
            timestamp: new Date().toISOString()
          }), { 
            qos: 1,
            retain: true 
          });
          
          log(`🧪 TEST: Marked ${binInfo.name} bin as full`, 'warning');
        }
        
        return;
      }
      
      if (payload.action === 'getStatus') {
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: state.isReady ? 'ready' : 'initializing',
          event: 'status_response',
          isReady: state.isReady,
          autoCycleEnabled: state.autoCycleEnabled,
          resetting: state.resetting,
          compactorRunning: state.compactorRunning,
          moduleId: state.moduleId,
          detectionStats: state.detectionStats,
          mode: 'guest_only',
          sensorEnabled: false,
          timestamp: new Date().toISOString()
        }));
        
        return;
      }
      
      if (payload.action === 'getDetectionStats') {
        logDetectionStats();
        return;
      }
      
      if (payload.action === 'emergencyStop') {
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
        
        log('🚪 IMMEDIATE GATE CLOSE - Attempt 1', 'warning');
        try {
          await executeCommand('closeGate');
          await delay(400);
          log('✅ Gate close command 1 sent', 'success');
        } catch (error) {
          log(`❌ Gate close attempt 1 failed: ${error.message}`, 'error');
        }
        
        log('🚪 IMMEDIATE GATE CLOSE - Attempt 2 (safety)', 'warning');
        try {
          await executeCommand('closeGate');
          await delay(400);
          log('✅ Gate close command 2 sent', 'success');
        } catch (error) {
          log(`❌ Gate close attempt 2 failed: ${error.message}`, 'error');
        }
        
        console.log('✅ Gate closing commands sent - proceeding with reset\n');
        
        state.resetting = false;
        
        await resetSystemForNextUser(false);
        return;
      }
      
      if (payload.action === 'runDiagnostics') {
        runDiagnostics();
        return;
      }
      
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
  } catch (error) {
    log(`MQTT error: ${error.message}`, 'error');
  }
});

mqttClient.on('error', (error) => {
  log(`MQTT error: ${error.message}`, 'error');
});

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
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  if (state.ws) {
    try {
      state.ws.close();
    } catch (e) {
      // Ignore
    }
  }
  
  setTimeout(() => {
    mqttClient.end();
    process.exit(0);
  }, 1000);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error.message}`, 'error');
  console.error(error);
  gracefulShutdown();
});

process.on('unhandledRejection', (error) => {
  log(`Unhandled rejection: ${error.message}`, 'error');
  console.error(error);
});

// ============================================
// STARTUP
// ============================================
console.log('='.repeat(50));
console.log('🚀 RVM AGENT - GUEST MODE - BIN STATUS FIXED');
console.log('='.repeat(50));
console.log(`Device: ${CONFIG.device.id}`);
console.log('Mode: Guest users only');
console.log('Object Sensor: DISABLED (automatic belt movement)');
console.log('Session timeout: 5 minutes inactivity');
console.log('✅ Gate closes IMMEDIATELY on session end');
console.log('✅ Bin status tracking with retain flag');
console.log('='.repeat(50) + '\n');