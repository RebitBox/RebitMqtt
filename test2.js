// agent-qr-event-driven.js - EVENT-DRIVEN OPTIMIZATION
// Based on hardware team recommendations - uses limit switches instead of timers
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const { GlobalKeyboardListener } = require('node-global-key-listener');

// ============================================
// CONFIGURATION - EVENT DRIVEN
// ============================================f
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
      qrScan: 'rvm/RVM-3101/qr/scanned',
      screenState: 'rvm/RVM-3101/screen/state',
      qrInput: 'rvm/RVM-3101/qr/input',
      guestStart: 'rvm/RVM-3101/guest/start',
      binStatus: 'rvm/RVM-3101/bin/status'
    }
  },
  
  qr: {
    enabled: true,
    minLength: 5,
    maxLength: 50,
    scanTimeout: 200,
    processingTimeout: 25000,
    debug: true
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
      moduleId: null,
      positions: { 
        home: '01',
        metalCan: '02',      // Hardware auto-positions
        plasticBottle: '03'   // Hardware auto-positions
      }
    }
  },
  
  detection: {
    METAL_CAN: 0.20,
    PLASTIC_BOTTLE: 0.27,
    GLASS: 0.22,
    retryDelay: 1100,
    maxRetries: 2,
    hasObjectSensor: false,
    minValidWeight: 4
  },
  
  timing: {
    // EVENT-DRIVEN: Most delays removed, only command spacing
    commandDelay: 100,              // 100ms between motor commands (as recommended)
    
    // Compactor runs in background
    compactor: 22000,
    
    // Session management
    autoPhotoDelay: 1650,           // Initial photo trigger delay
    sessionTimeout: 120000,
    sessionMaxDuration: 600000,
    
    // Minimal delays for non-hardware operations
    calibrationSettle: 500,         // Brief settle after calibration
    gateOperation: 500,             // Brief settle after gate
    resetHomeSettle: 800,           // Brief settle after reset home
    
    // Safety timeouts for hardware responses
    hardwareResponseTimeout: 5000   // Max wait for hardware limit switch
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
  
  // QR Scanner state
  qrBuffer: '',
  lastCharTime: 0,
  qrTimer: null,
  processingQR: false,
  processingQRTimeout: null,
  globalKeyListener: null,
  lastSuccessfulScan: null,
  lastKeyboardActivity: Date.now(),
  
  // Session tracking
  sessionId: null,
  sessionCode: null,
  currentUserId: null,
  currentUserData: null,
  isMember: false,
  isGuestSession: false,
  itemsProcessed: 0,
  sessionStartTime: null,
  lastActivityTime: null,
  sessionTimeoutTimer: null,
  maxDurationTimer: null,
  
  // Hardware state - EVENT DRIVEN
  compactorRunning: false,
  compactorTimer: null,
  autoPhotoTimer: null,
  detectionRetries: 0,
  awaitingDetection: false,
  resetting: false,
  
  // Event-driven cycle state
  cycleState: 'IDLE',  // IDLE, BELT_MOVING, POSITIONED, DROPPING, RESETTING
  pendingOperation: null,
  hardwareResponseTimer: null,
  
  // Bin status tracking
  binStatus: {
    plastic: false,
    metal: false,
    right: false,
    glass: false
  },
  
  // Performance tracking
  lastCycleTime: null,
  averageCycleTime: null,
  cycleCount: 0,
  cycleStartTime: null
};

// ============================================
// UTILITY FUNCTIONS
// ============================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(message, level = 'info') {
  if (level === 'error' || level === 'warning' || level === 'critical') {
    const timestamp = new Date().toISOString();
    const prefix = {
      'error': '❌',
      'warning': '⚠️',
      'critical': '✅'
    }[level] || 'ℹ️';
    console.log(`[${timestamp}] ${prefix} ${message}`);
  }
}

function trackCycleTime() {
  if (!state.cycleStartTime) return;
  
  const cycleTime = Date.now() - state.cycleStartTime;
  state.lastCycleTime = cycleTime;
  state.cycleCount++;
  
  if (state.averageCycleTime === null) {
    state.averageCycleTime = cycleTime;
  } else {
    state.averageCycleTime = (state.averageCycleTime * (state.cycleCount - 1) + cycleTime) / state.cycleCount;
  }
  
  state.cycleStartTime = null;
  
  if (state.cycleCount % 10 === 0) {
    console.log(`⚡ Cycle #${state.cycleCount}: ${(cycleTime / 1000).toFixed(1)}s | Avg: ${(state.averageCycleTime / 1000).toFixed(1)}s`);
  }
}

function clearHardwareTimeout() {
  if (state.hardwareResponseTimer) {
    clearTimeout(state.hardwareResponseTimer);
    state.hardwareResponseTimer = null;
  }
}

function setHardwareTimeout(callback, operation) {
  clearHardwareTimeout();
  state.hardwareResponseTimer = setTimeout(() => {
    log(`Hardware timeout: ${operation}`, 'warning');
    callback();
  }, CONFIG.timing.hardwareResponseTimeout);
}

// ============================================
// QR SCANNER
// ============================================

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
  state.qrBuffer = '';
}

async function validateQRWithBackend(sessionCode) {
  try {
    const response = await axios.post(
      `${CONFIG.backend.url}api/rvm/${CONFIG.device.id}/qr/validate`,
      { sessionCode },
      {
        timeout: CONFIG.backend.timeout,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    if (response.data.success) {
      return {
        valid: true,
        user: response.data.user,
        session: response.data.session
      };
    } else {
      return {
        valid: false,
        error: response.data.error || 'Invalid QR code'
      };
    }
    
  } catch (error) {
    log(`QR validation error: ${error.message}`, 'error');
    return {
      valid: false,
      error: error.response?.data?.error || 'Network error'
    };
  }
}

async function processQRCode(qrData) {
  if (!canAcceptQRScan()) {
    return;
  }
  
  const cleanCode = qrData.replace(/[\r\n\t]/g, '').trim();
  
  if (cleanCode.length < CONFIG.qr.minLength || cleanCode.length > CONFIG.qr.maxLength) {
    log(`Invalid QR length: ${cleanCode.length}`, 'error');
    return;
  }
  
  state.processingQR = true;
  state.processingQRTimeout = setTimeout(() => {
    log('QR timeout', 'warning');
    clearQRProcessing();
  }, CONFIG.qr.processingTimeout);
  
  console.log(`📱 QR: ${cleanCode}`);
  
  try {
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'qr_validating',
      message: 'Validating...',
      timestamp: new Date().toISOString()
    }));
    
    const validation = await validateQRWithBackend(cleanCode);
    
    if (validation.valid) {
      state.lastSuccessfulScan = new Date().toISOString();
      
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId: CONFIG.device.id,
        state: 'qr_validated',
        message: `Welcome ${validation.user.name}!`,
        user: validation.user,
        timestamp: new Date().toISOString()
      }));
      
      await delay(1500);
      
      clearQRProcessing();
      
      await startMemberSession(validation);
      
    } else {
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId: CONFIG.device.id,
        state: 'qr_invalid',
        message: validation.error,
        timestamp: new Date().toISOString()
      }));
      
      await delay(2500);
      
      mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
        deviceId: CONFIG.device.id,
        state: 'ready_for_qr',
        message: 'Please scan your QR code',
        timestamp: new Date().toISOString()
      }));
      
      clearQRProcessing();
    }
    
  } catch (error) {
    log(`QR error: ${error.message}`, 'error');
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'error',
      message: 'Error - please try again',
      timestamp: new Date().toISOString()
    }));
    
    await delay(2500);
    
    clearQRProcessing();
    
  } finally {
    clearQRProcessing();
  }
}

function setupQRScanner() {
  if (!CONFIG.qr.enabled) {
    log('QR scanner disabled', 'warning');
    return;
  }
  
  if (state.globalKeyListener) {
    return;
  }
  
  const CONSOLE_PATTERNS = [
    /^C:\\/i,
    /^[A-Z]:\\/i,
    /operable program/i,
    /batch file/i,
    /Users\\/i,
    /\\rebit-mqtt/i,
    /node/i,
    /RVM AGENT/i
  ];
  
  function isConsoleOutput(text) {
    return CONSOLE_PATTERNS.some(pattern => pattern.test(text));
  }
  
  const gkl = new GlobalKeyboardListener();
  
  gkl.addListener((e, down) => {
    if (e.state !== 'DOWN') return;
    
    state.lastKeyboardActivity = Date.now();
    
    if (!canAcceptQRScan()) {
      return;
    }
    
    const currentTime = Date.now();
    
    if (e.name === 'RETURN' || e.name === 'ENTER') {
      if (state.qrBuffer.length >= CONFIG.qr.minLength && 
          state.qrBuffer.length <= CONFIG.qr.maxLength &&
          !isConsoleOutput(state.qrBuffer)) {
        
        const qrCode = state.qrBuffer;
        state.qrBuffer = '';
        
        if (state.qrTimer) {
          clearTimeout(state.qrTimer);
          state.qrTimer = null;
        }
        
        processQRCode(qrCode).catch(error => {
          log(`QR error: ${error.message}`, 'error');
          clearQRProcessing();
        });
        
      } else {
        state.qrBuffer = '';
      }
      return;
    }
    
    const char = e.name;
    
    if (char.length === 1) {
      const timeDiff = currentTime - state.lastCharTime;
      
      if (timeDiff > CONFIG.qr.scanTimeout && state.qrBuffer.length > 0) {
        state.qrBuffer = '';
      }
      
      if (state.qrBuffer.length >= CONFIG.qr.maxLength) {
        state.qrBuffer = '';
        if (state.qrTimer) {
          clearTimeout(state.qrTimer);
          state.qrTimer = null;
        }
        return;
      }
      
      state.qrBuffer += char;
      state.lastCharTime = currentTime;
      
      if (state.qrTimer) {
        clearTimeout(state.qrTimer);
      }
      
      state.qrTimer = setTimeout(() => {
        if (state.qrBuffer.length >= CONFIG.qr.minLength && 
            state.qrBuffer.length <= CONFIG.qr.maxLength &&
            !isConsoleOutput(state.qrBuffer)) {
          
          const qrCode = state.qrBuffer;
          state.qrBuffer = '';
          
          processQRCode(qrCode).catch(error => {
            log(`QR error: ${error.message}`, 'error');
            clearQRProcessing();
          });
          
        } else {
          state.qrBuffer = '';
        }
        state.qrTimer = null;
      }, CONFIG.qr.scanTimeout);
    }
  });
  
  state.globalKeyListener = gkl;
}

function checkScannerHealth() {
  const now = Date.now();
  const timeSinceActivity = now - state.lastKeyboardActivity;
  
  if (state.processingQR && state.processingQRTimeout === null) {
    log('processingQR stuck - clearing', 'warning');
    clearQRProcessing();
  }
  
  if (!state.globalKeyListener && state.isReady && !state.autoCycleEnabled) {
    log('Keyboard listener missing - recreating', 'warning');
    setupQRScanner();
  }
  
  if (!state.autoCycleEnabled && state.isReady && timeSinceActivity > 180000) {
    log('No keyboard activity - restarting listener', 'warning');
    
    if (state.globalKeyListener) {
      try {
        state.globalKeyListener.kill();
      } catch (e) {}
      state.globalKeyListener = null;
    }
    
    setupQRScanner();
    state.lastKeyboardActivity = Date.now();
  }
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
      checkScannerHealth();
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
          CONFIG.motors.stepper.moduleId = state.moduleId;
          
          console.log('🟢 SYSTEM READY - EVENT DRIVEN MODE');
          
          setupQRScanner();
          
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status: 'ready',
            event: 'startup_ready',
            moduleId: state.moduleId,
            isReady: true,
            eventDrivenMode: true,
            timestamp
          }), { qos: 1 });
          
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id,
            state: 'ready_for_qr',
            message: 'Please scan your QR code',
            timestamp
          }));
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
      cycleState: state.cycleState,
      canAcceptQRScan: canAcceptQRScan(),
      lastCycleTime: state.lastCycleTime,
      averageCycleTime: state.averageCycleTime,
      cycleCount: state.cycleCount,
      eventDrivenMode: true,
      timestamp
    }), { qos: 1 });
    
    const status = state.autoCycleEnabled ? 'SESSION' : (canAcceptQRScan() ? 'READY' : 'BUSY');
    const perf = state.lastCycleTime ? ` ${(state.lastCycleTime/1000).toFixed(1)}s` : '';
    console.log(`💓 ${status}${perf} [${state.cycleState}]`);
  }
};

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
// HARDWARE CONTROL - EVENT DRIVEN
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
      apiPayload = { moduleId: state.moduleId, motorId: '01', type: '00', deviceType };
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
        moduleId: CONFIG.motors.stepper.moduleId || state.moduleId,
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
    
    // Only 100ms delay between motor commands as recommended
    await delay(CONFIG.timing.commandDelay);
    
  } catch (error) {
    log(`${action} failed: ${error.message}`, 'error');
    throw error;
  }
}

// ============================================
// MATERIAL DETECTION
// ============================================
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  
  let materialType = 'UNKNOWN';
  let threshold = 1.0;
  let hasStrongKeyword = false;
  
  if (className.includes('易拉罐') || className.includes('metal') || 
      className.includes('can') || className.includes('铝')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = className.includes('易拉罐') || className.includes('铝');
  } 
  else if (className.includes('pet') || className.includes('plastic') || 
           className.includes('瓶') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = className.includes('pet');
  } 
  else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS';
    threshold = CONFIG.detection.GLASS;
    hasStrongKeyword = className.includes('玻璃');
  }
  
  const confidencePercent = Math.round(probability * 100);
  
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    const relaxedThreshold = threshold * 0.3;
    
    if (hasStrongKeyword && probability >= relaxedThreshold) {
      log(`${materialType} (${confidencePercent}% - keyword)`, 'success');
      return materialType;
    }
    
    log(`${materialType} too low (${confidencePercent}%)`, 'warning');
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') {
    log(`${materialType} (${confidencePercent}%)`, 'success');
  }
  
  return materialType;
}

// ============================================
// COMPACTOR
// ============================================
async function startCompactor() {
  if (state.compactorRunning) {
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    
    if (state.compactorTimer) {
      clearTimeout(state.compactorTimer);
      state.compactorTimer = null;
    }
    
    state.compactorRunning = false;
    await delay(500);
  }
  
  state.compactorRunning = true;
  
  await executeCommand('customMotor', CONFIG.motors.compactor.start);
  
  state.compactorTimer = setTimeout(async () => {
    try {
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    } catch (error) {
      log(`Compactor stop error: ${error.message}`, 'error');
    }
    
    state.compactorRunning = false;
    state.compactorTimer = null;
  }, CONFIG.timing.compactor);
}

// ============================================
// EVENT-DRIVEN CYCLE LOGIC
// ============================================

async function executeRejectionCycle() {
  console.log('❌ Rejection');

  try {
    state.cycleState = 'REVERSING';
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    
    // Wait for hardware limit switch to trigger belt stop
    // Hardware will send signal when reverse is complete
    state.pendingOperation = 'REJECTION_COMPLETE';
    
  } catch (error) {
    log(`Rejection error: ${error.message}`, 'error');
    await resetCycleState();
  }
}

async function resetCycleState() {
  state.cycleState = 'IDLE';
  state.pendingOperation = null;
  state.aiResult = null;
  state.weight = null;
  state.detectionRetries = 0;
  state.awaitingDetection = false;
  state.cycleInProgress = false;
  clearHardwareTimeout();
  
  if (state.autoCycleEnabled) {
    // Trigger next detection
    setTimeout(() => {
      if (state.autoCycleEnabled && state.cycleState === 'IDLE') {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
}

// EVENT-DRIVEN: This is called when hardware sends limit switch signal
async function handleBeltLimitReached() {
  clearHardwareTimeout();
  
  if (state.cycleState === 'BELT_MOVING' && state.pendingOperation === 'TRIGGER_WEIGHT_PHOTO') {
    console.log('🎯 Belt reached stepper position - triggering detection');
    state.cycleState = 'POSITIONED';
    state.pendingOperation = null;
    
    // Hardware reached position - now trigger weight and photo
    // These will be triggered by hardware feedback, not timers
    await executeCommand('getWeight');
    // Weight result will come via WebSocket function '06'
    
  } else if (state.cycleState === 'REVERSING' && state.pendingOperation === 'REJECTION_COMPLETE') {
    console.log('✅ Rejection complete');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    mqttClient.publish('rvm/RVM-3101/item/rejected', JSON.stringify({
      deviceId: CONFIG.device.id,
      reason: 'LOW_CONFIDENCE',
      userId: state.currentUserId,
      sessionCode: state.sessionCode,
      timestamp: new Date().toISOString()
    }));
    
    await resetCycleState();
    
  } else if (state.cycleState === 'DROPPING' && state.pendingOperation === 'DROP_COMPLETE') {
    console.log('✅ Bottle dropped');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    state.cycleState = 'RESETTING';
    state.pendingOperation = 'RESET_AND_NEXT';
    
    // Hardware auto-resets stepper to home - send home position command
    // Hardware will automatically position itself
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    
    // Start compactor in parallel
    startCompactor().catch(error => {
      log(`Compactor error: ${error.message}`, 'error');
    });
    
    // Immediately trigger next photo (parallel operation)
    setTimeout(() => {
      if (state.autoCycleEnabled && state.pendingOperation === 'RESET_AND_NEXT') {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, 300);
    
  } else if (state.cycleState === 'RESETTING' && state.pendingOperation === 'RESET_AND_NEXT') {
    console.log('✅ Stepper reset complete');
    
    // Publish cycle complete
    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify({
      deviceId: CONFIG.device.id,
      material: state.aiResult?.materialType,
      weight: state.weight?.weight,
      userId: state.currentUserId,
      sessionCode: state.sessionCode,
      itemNumber: state.itemsProcessed,
      timestamp: new Date().toISOString()
    }));
    
    trackCycleTime();
    resetInactivityTimer();
    
    await resetCycleState();
  }
}

async function executeEventDrivenCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    state.cycleInProgress = false;
    return;
  }

  if (!state.cycleStartTime) {
    state.cycleStartTime = Date.now();
  }
  
  state.itemsProcessed++;
  
  console.log(`⚡ Cycle #${state.itemsProcessed}: ${state.aiResult.materialType} ${state.weight.weight}g`);

  try {
    // STEP 1: Move belt to stepper position
    state.cycleState = 'BELT_MOVING';
    state.pendingOperation = 'TRIGGER_WEIGHT_PHOTO';
    
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    
    // Set timeout in case hardware doesn't respond
    setHardwareTimeout(async () => {
      log('Belt movement timeout - assuming position reached', 'warning');
      await handleBeltLimitReached();
    }, 'belt_to_stepper');
    
    // Hardware will send limit switch signal (type '03') when position reached
    // This will trigger handleBeltLimitReached()
    
  } catch (error) {
    log(`Cycle error: ${error.message}`, 'error');
    await resetCycleState();
  }
}

// Called after weight is confirmed
async function continueAfterWeight() {
  if (state.cycleState !== 'POSITIONED') return;
  
  try {
    // STEP 2: Position stepper (hardware auto-positions)
    const targetPosition = state.aiResult.materialType === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    await executeCommand('stepperMotor', { position: targetPosition });
    
    // Hardware automatically moves stepper - no waiting needed
    // Immediately proceed to drop
    
    // STEP 3: Drop bottle
    state.cycleState = 'DROPPING';
    state.pendingOperation = 'DROP_COMPLETE';
    
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    
    // Set timeout in case hardware doesn't respond
    setHardwareTimeout(async () => {
      log('Drop timeout - assuming complete', 'warning');
      await handleBeltLimitReached();
    }, 'belt_reverse');
    
    // Hardware will send limit switch signal when drop complete
    
  } catch (error) {
    log(`Cycle continuation error: ${error.message}`, 'error');
    await resetCycleState();
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================
async function startMemberSession(validationData) {
  console.log(`🎬 SESSION: ${validationData.user.name}`);
  
  try {
    state.isReady = false;
    
    state.currentUserId = validationData.user.id;
    state.sessionId = validationData.session.sessionId;
    state.sessionCode = validationData.session.sessionCode;
    state.currentUserData = {
      name: validationData.user.name,
      email: validationData.user.email,
      currentPoints: validationData.user.currentPoints
    };
    state.isMember = true;
    state.isGuestSession = false;
    
    state.autoCycleEnabled = true;
    state.itemsProcessed = 0;
    state.sessionStartTime = new Date();
    startSessionTimers();
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    if (state.compactorRunning) {
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
      if (state.compactorTimer) {
        clearTimeout(state.compactorTimer);
        state.compactorTimer = null;
      }
      state.compactorRunning = false;
    }
    
    // Reset to home (hardware auto-positions)
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.resetHomeSettle);
    
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationSettle);
    
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'session_active',
      message: 'Insert your items - event-driven mode!',
      user: {
        name: validationData.user.name,
        currentPoints: validationData.user.currentPoints
      },
      timestamp: new Date().toISOString()
    }));
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'session_active',
      event: 'session_started',
      sessionType: 'member',
      userId: state.currentUserId,
      sessionId: state.sessionId,
      sessionCode: state.sessionCode,
      eventDrivenMode: true,
      timestamp: new Date().toISOString()
    }));
    
    // Initial photo trigger
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
    
  } catch (error) {
    log(`Session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function startGuestSession(sessionData) {
  console.log('🎬 GUEST SESSION');
  
  try {
    state.isReady = false;
    
    state.currentUserId = null;
    state.sessionId = sessionData.sessionId;
    state.sessionCode = sessionData.sessionCode;
    state.currentUserData = null;
    state.isMember = false;
    state.isGuestSession = true;
    
    state.autoCycleEnabled = true;
    state.itemsProcessed = 0;
    state.sessionStartTime = new Date();
    startSessionTimers();
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    if (state.compactorRunning) {
      await executeCommand('customMotor', CONFIG.motors.compactor.stop);
      if (state.compactorTimer) {
        clearTimeout(state.compactorTimer);
        state.compactorTimer = null;
      }
      state.compactorRunning = false;
    }
    
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.resetHomeSettle);
    
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationSettle);
    
    await executeCommand('openGate');
    await delay(CONFIG.timing.gateOperation);
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'session_active',
      message: 'Insert your items - event-driven mode!',
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
      eventDrivenMode: true,
      timestamp: new Date().toISOString()
    }));
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
    
  } catch (error) {
    log(`Session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function resetSystemForNextUser(forceStop = false) {
  console.log('🔄 RESET');
  
  if (state.resetting) {
    return;
  }
  
  state.resetting = true;
  
  try {
    state.autoCycleEnabled = false;
    state.awaitingDetection = false;
    
    clearHardwareTimeout();
    
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
    
    if (state.compactorRunning) {
      if (forceStop) {
        await executeCommand('customMotor', CONFIG.motors.compactor.stop);
        if (state.compactorTimer) {
          clearTimeout(state.compactorTimer);
          state.compactorTimer = null;
        }
        state.compactorRunning = false;
      }
    }
    
    await executeCommand('closeGate');
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

  } catch (error) {
    log(`Reset error: ${error.message}`, 'error');
  } finally {
    state.aiResult = null;
    state.weight = null;
    state.currentUserId = null;
    state.currentUserData = null;
    state.sessionId = null;
    state.sessionCode = null;
    state.calibrationAttempts = 0;
    state.cycleInProgress = false;
    state.itemsProcessed = 0;
    state.sessionStartTime = null;
    state.detectionRetries = 0;
    state.isMember = false;
    state.isGuestSession = false;
    state.cycleState = 'IDLE';
    state.pendingOperation = null;
    state.cycleStartTime = null;
    
    clearSessionTimers();
    clearQRProcessing();
    
    state.resetting = false;
    state.isReady = true;
    
    console.log('✅ READY');
    
    mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
      deviceId: CONFIG.device.id,
      status: 'ready',
      event: 'reset_complete',
      isReady: true,
      autoCycleEnabled: false,
      eventDrivenMode: true,
      timestamp: new Date().toISOString()
    }));
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'ready_for_qr',
      message: 'Please scan your QR code',
      timestamp: new Date().toISOString()
    }));
  }
}

// ============================================
// SESSION TIMERS
// ============================================

async function handleSessionTimeout(reason) {
  console.log('\n⏱️ SESSION TIMEOUT:', reason);
  
  state.autoCycleEnabled = false;
  state.awaitingDetection = false;
  
  if (state.autoPhotoTimer) {
    clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = null;
  }
  
  try {
    if (state.sessionCode && state.itemsProcessed > 0) {
      mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
        deviceId: CONFIG.device.id,
        status: 'session_timeout',
        event: 'session_timeout',
        reason: reason,
        sessionCode: state.sessionCode,
        userId: state.currentUserId,
        itemsProcessed: state.itemsProcessed,
        sessionType: state.isMember ? 'member' : 'guest',
        timestamp: new Date().toISOString()
      }));
      
      await delay(2000);
    }
  } catch (error) {}
  
  if (state.cycleInProgress) {
    const maxWait = 60000;
    const startWait = Date.now();
    
    while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
      await delay(1000);
    }
  }
  
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
// WEBSOCKET - EVENT DRIVEN HANDLERS
// ============================================
function connectWebSocket() {
  if (state.ws) {
    try {
      state.ws.removeAllListeners();
      state.ws.close();
    } catch (e) {}
    state.ws = null;
  }
  
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    if (!state.moduleId) {
      setTimeout(() => requestModuleId(), 1000);
    }
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
          CONFIG.motors.stepper.moduleId = state.moduleId;
          
          console.log('🟢 SYSTEM READY - EVENT DRIVEN');
          
          setupQRScanner();
          
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status: 'ready',
            moduleId: state.moduleId,
            isReady: true,
            eventDrivenMode: true,
            timestamp: new Date().toISOString()
          }));
          
          mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
            deviceId: CONFIG.device.id,
            state: 'ready_for_qr',
            message: 'Please scan your QR code',
            timestamp: new Date().toISOString()
          }));
        }
        return;
      }
      
      // EVENT DRIVEN: Hardware limit switch reached (type '03')
      // This is the key optimization - hardware tells us when position reached
      if (message.function === '02' && message.data === '03') {
        console.log('🎯 Hardware limit switch triggered');
        await handleBeltLimitReached();
        return;
      }
      
      // AI Photo Result
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
          if (state.aiResult.materialType !== 'UNKNOWN') {
            state.detectionRetries = 0;
            state.awaitingDetection = false;
            
            // Trigger weight measurement - result comes via function '06'
            setTimeout(() => executeCommand('getWeight'), 300);
          } else {
            state.detectionRetries++;
            
            if (state.detectionRetries < CONFIG.detection.maxRetries) {
              setTimeout(() => {
                if (state.autoCycleEnabled) {
                  executeCommand('takePhoto');
                }
              }, CONFIG.detection.retryDelay);
            } else {
              state.awaitingDetection = false;
              state.cycleInProgress = true;
              setTimeout(() => executeRejectionCycle(), 1000);
            }
          }
        }
        return;
      }
      
      // Bin Status
      if (message.function === 'deviceStatus') {
        const binCode = parseInt(message.data);
        
        const binStatusMap = {
          0: { name: 'Plastic (PET)', key: 'plastic', critical: true },
          1: { name: 'Metal Can', key: 'metal', critical: true },
          2: { name: 'Right Bin', key: 'right', critical: false },
          3: { name: 'Glass', key: 'glass', critical: false },
          4: { name: 'Infrared Sensor', key: null, critical: false }
        };
        
        const binInfo = binStatusMap[binCode];
        
        if (binInfo) {
          console.log(`⚠️ BIN STATUS: ${binInfo.name} full`);
          
          if (binInfo.key) {
            state.binStatus[binInfo.key] = true;
          }
          
          mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
            deviceId: CONFIG.device.id,
            binCode: binCode,
            binName: binInfo.name,
            binKey: binInfo.key,
            isFull: true,
            critical: binInfo.critical,
            binStatus: state.binStatus,
            timestamp: new Date().toISOString()
          }));
          
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
              log('Current material bin full - ending session', 'warning');
              setTimeout(async () => {
                await handleSessionTimeout('bin_full');
              }, 2000);
            }
          }
        }
        return;
      }
      
      // Weight Result
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
        
        if (state.weight.weight <= 0 && state.calibrationAttempts < 2) {
          state.calibrationAttempts++;
          setTimeout(async () => {
            await executeCommand('calibrateWeight');
            await delay(CONFIG.timing.calibrationSettle);
            await executeCommand('getWeight');
          }, 500);
          return;
        }
        
        if (state.weight.weight > 0) state.calibrationAttempts = 0;
        
        if (state.autoCycleEnabled && state.aiResult && !state.cycleInProgress) {
          if (state.weight.weight < CONFIG.detection.minValidWeight) {
            state.aiResult = null;
            state.weight = null;
            state.awaitingDetection = false;
            
            if (state.autoPhotoTimer) {
              clearTimeout(state.autoPhotoTimer);
            }
            
            state.autoPhotoTimer = setTimeout(() => {
              if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
                state.awaitingDetection = true;
                executeCommand('takePhoto');
              }
            }, CONFIG.timing.autoPhotoDelay);
            
            return;
          }
          
          state.cycleInProgress = true;
          
          // Event-driven: Start cycle, hardware will trigger next steps
          setTimeout(() => executeEventDrivenCycle(), 300);
          
          // Also continue with stepper positioning
          setTimeout(() => continueAfterWeight(), 500);
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
  log('✅ MQTT connected', 'critical');
  
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.qrInput);
  mqttClient.subscribe(CONFIG.mqtt.topics.guestStart);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    event: 'device_connected',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'ready',
    event: 'startup_ready',
    isReady: true,
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
        log('Cannot start guest session - device not ready', 'warning');
        return;
      }
      
      if (state.autoCycleEnabled) {
        await resetSystemForNextUser(false);
        await delay(2000);
      }
      
      await startGuestSession(payload);
      return;
    }
    
    if (topic === CONFIG.mqtt.topics.commands) {
      if (payload.action === 'getStatus') {
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: state.isReady ? 'ready' : 'initializing',
          event: 'status_response',
          isReady: state.isReady,
          autoCycleEnabled: state.autoCycleEnabled,
          cycleState: state.cycleState,
          resetting: state.resetting,
          processingQR: state.processingQR,
          moduleId: state.moduleId,
          eventDrivenMode: true,
          cycleCount: state.cycleCount,
          averageCycleTime: state.averageCycleTime,
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (payload.action === 'emergencyStop') {
        await executeCommand('closeGate');
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        
        if (state.compactorRunning) {
          await executeCommand('customMotor', CONFIG.motors.compactor.stop);
          if (state.compactorTimer) clearTimeout(state.compactorTimer);
          state.compactorRunning = false;
        }
        
        state.autoCycleEnabled = false;
        state.cycleInProgress = false;
        state.resetting = false;
        state.isReady = false;
        clearHardwareTimeout();
        return;
      }
      
      if (payload.action === 'forceReset') {
        state.cycleInProgress = false;
        state.resetting = false;
        clearHardwareTimeout();
        await resetSystemForNextUser(true);
        return;
      }
      
      if (payload.action === 'endSession') {
        await resetSystemForNextUser(false);
        return;
      }
      
      if (payload.action === 'getBinStatus') {
        mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
          deviceId: CONFIG.device.id,
          binStatus: state.binStatus,
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (payload.action === 'resetBinStatus') {
        state.binStatus.plastic = false;
        state.binStatus.metal = false;
        state.binStatus.right = false;
        state.binStatus.glass = false;
        
        console.log('🗑️ Bin status reset');
        
        mqttClient.publish(CONFIG.mqtt.topics.binStatus, JSON.stringify({
          deviceId: CONFIG.device.id,
          action: 'reset',
          binStatus: state.binStatus,
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (state.moduleId) {
        await executeCommand(payload.action, payload.params);
      }
    }
    
    if (topic === CONFIG.mqtt.topics.qrInput) {
      const { qrCode } = payload;
      
      if (canAcceptQRScan()) {
        processQRCode(qrCode).catch(error => {
          log(`QR error: ${error.message}`, 'error');
        });
      }
    }
    
  } catch (error) {
    log(`MQTT error: ${error.message}`, 'error');
  }
});

mqttClient.on('error', (error) => {
  log(`MQTT error: ${error.message}`, 'error');
});

mqttClient.on('disconnect', () => {
  log('⚠️ MQTT disconnected', 'warning');
});

mqttClient.on('reconnect', () => {
  log('🔄 MQTT reconnecting...', 'warning');
});

// ============================================
// SHUTDOWN
// ============================================
function gracefulShutdown() {
  console.log('\n⏹️ Shutting down event-driven agent...\n');
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  clearQRProcessing();
  clearHardwareTimeout();
  heartbeat.stop();
  
  if (state.compactorTimer) clearTimeout(state.compactorTimer);
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  
  clearSessionTimers();
  
  if (state.globalKeyListener) {
    try {
      state.globalKeyListener.kill();
    } catch (e) {}
  }
  
  if (state.ws) {
    try {
      state.ws.close();
    } catch (e) {}
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
console.log('='.repeat(60));
console.log('🚀 RVM AGENT - EVENT DRIVEN MODE');
console.log('='.repeat(60));
console.log(`Device: ${CONFIG.device.id}`);
console.log('Mode: Hardware limit switches (type 03)');
console.log('Expected: <10s per bottle with parallel operations');
console.log('='.repeat(60) + '\n');