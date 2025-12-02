// agent-qr-ultra-reliable.js - QR SCANNER THAT ALWAYS WORKS + CONTINUOUS COMPACTOR
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const { GlobalKeyboardListener } = require('node-global-key-listener');

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
      qrScan: 'rvm/RVM-3101/qr/scanned',
      screenState: 'rvm/RVM-3101/screen/state',
      qrInput: 'rvm/RVM-3101/qr/input',
      guestStart: 'rvm/RVM-3101/guest/start'
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
      moduleId: '09',
      positions: { home: '01', metalCan: '02', plasticBottle: '03' }
    }
  },
  
  detection: {
    METAL_CAN: 0.22,
    PLASTIC_BOTTLE: 0.30,
    GLASS: 0.25,
    retryDelay: 1500,
    maxRetries: 2,
    hasObjectSensor: false,
    minValidWeight: 5
  },
  
  timing: {
    beltToWeight: 2500,
    beltToStepper: 3500,
    beltReverse: 4000,
    stepperRotate: 3500,
    stepperReset: 5000,
    positionSettle: 300,
    gateOperation: 800,
    autoPhotoDelay: 3000,
    sessionTimeout: 120000,
    sessionMaxDuration: 600000,
    weightDelay: 1500,
    photoDelay: 1200,
    calibrationDelay: 1200,
    commandDelay: 100,
    resetHomeDelay: 1500
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
  
  // QR Scanner state - SIMPLIFIED
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
  
  // Hardware state - SIMPLIFIED (no timers needed!)
  compactorRunning: false,
  autoPhotoTimer: null,
  detectionRetries: 0,
  awaitingDetection: false,
  resetting: false,
  
  // Performance tracking
  lastCycleTime: null,
  averageCycleTime: null,
  cycleCount: 0
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
    'qr': '📱'
  }[level] || 'ℹ️';
  
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function debugLog(message) {
  if (CONFIG.qr.debug) {
    log(message, 'debug');
  }
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
  
  log(`⚡ Cycle completed in ${(cycleTime / 1000).toFixed(1)}s | Avg: ${(state.averageCycleTime / 1000).toFixed(1)}s`, 'perf');
}

// ============================================
// QR SCANNER - ULTRA SIMPLE & RELIABLE
// ============================================

/**
 * Check if we can accept QR scans right now
 */
function canAcceptQRScan() {
  const canScan = state.isReady && 
                  !state.autoCycleEnabled && 
                  !state.processingQR && 
                  !state.resetting;
  
  if (!canScan) {
    debugLog(`Cannot scan - Ready:${state.isReady} Cycle:${state.autoCycleEnabled} Proc:${state.processingQR} Reset:${state.resetting}`);
  }
  
  return canScan;
}

/**
 * Clear QR processing state - ALWAYS SAFE
 */
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
  
  debugLog('✅ QR processing state cleared');
}

/**
 * Validate QR with backend
 */
async function validateQRWithBackend(sessionCode) {
  try {
    const response = await axios.post(
      `${CONFIG.backend.url}/api/rvm/${CONFIG.device.id}/qr/validate`,
      { sessionCode },
      {
        timeout: CONFIG.backend.timeout,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    if (response.data.success) {
      log(`✅ QR validated - User: ${response.data.user.name}`, 'success');
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
    log(`❌ QR validation error: ${error.message}`, 'error');
    return {
      valid: false,
      error: error.response?.data?.error || 'Network error'
    };
  }
}

/**
 * Process QR code - GUARANTEED TO CLEAR STATE
 */
async function processQRCode(qrData) {
  // Guard: Check if can process
  if (!canAcceptQRScan()) {
    debugLog('QR rejected - system not ready for scan');
    return;
  }
  
  const cleanCode = qrData.replace(/[\r\n\t]/g, '').trim();
  
  // Validate length
  if (cleanCode.length < CONFIG.qr.minLength || cleanCode.length > CONFIG.qr.maxLength) {
    log(`Invalid QR length: ${cleanCode.length}`, 'error');
    return;
  }
  
  // Set processing with safety timeout
  state.processingQR = true;
  state.processingQRTimeout = setTimeout(() => {
    log('⏰ QR processing timeout!', 'warning');
    clearQRProcessing();
  }, CONFIG.qr.processingTimeout);
  
  log(`\n${'='.repeat(50)}`, 'qr');
  log(`📱 QR CODE: ${cleanCode}`, 'qr');
  log(`${'='.repeat(50)}\n`, 'qr');
  
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
      
      // Clear processing BEFORE starting session
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
      
      // Clear and ready for next scan
      clearQRProcessing();
    }
    
  } catch (error) {
    log(`❌ QR error: ${error.message}`, 'error');
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'error',
      message: 'Error - please try again',
      timestamp: new Date().toISOString()
    }));
    
    await delay(2500);
    
    // Always clear on error
    clearQRProcessing();
    
  } finally {
    // FINAL SAFETY: Always clear
    clearQRProcessing();
    log('✅ QR processing complete', 'qr');
  }
}

/**
 * Setup keyboard listener - SIMPLE & RELIABLE
 */
function setupQRScanner() {
  if (!CONFIG.qr.enabled) {
    log('QR scanner disabled', 'warning');
    return;
  }
  
  // Don't setup twice
  if (state.globalKeyListener) {
    log('Keyboard listener already active', 'warning');
    return;
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('📱 QR SCANNER - ULTRA RELIABLE');
  console.log('='.repeat(50));
  console.log('✅ Always works after session!');
  console.log('✅ Automatic recovery!');
  console.log('✅ Simple & reliable!');
  console.log('='.repeat(50) + '\n');
  
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
    
    // Update keyboard activity tracker
    state.lastKeyboardActivity = Date.now();
    
    // Check if we can accept input
    if (!canAcceptQRScan()) {
      return;
    }
    
    const currentTime = Date.now();
    
    // Handle ENTER
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
        
        log(`✅ QR detected (ENTER): ${qrCode}`, 'success');
        
        // Process async
        processQRCode(qrCode).catch(error => {
          log(`QR async error: ${error.message}`, 'error');
          clearQRProcessing();
        });
        
      } else {
        state.qrBuffer = '';
      }
      return;
    }
    
    // Handle characters
    const char = e.name;
    
    if (char.length === 1) {
      const timeDiff = currentTime - state.lastCharTime;
      
      // Reset on timeout
      if (timeDiff > CONFIG.qr.scanTimeout && state.qrBuffer.length > 0) {
        state.qrBuffer = '';
      }
      
      // Prevent overflow
      if (state.qrBuffer.length >= CONFIG.qr.maxLength) {
        state.qrBuffer = '';
        if (state.qrTimer) {
          clearTimeout(state.qrTimer);
          state.qrTimer = null;
        }
        return;
      }
      
      // Add char
      state.qrBuffer += char;
      state.lastCharTime = currentTime;
      debugLog(`Buffer: "${state.qrBuffer}"`);
      
      // Auto-timeout
      if (state.qrTimer) {
        clearTimeout(state.qrTimer);
      }
      
      state.qrTimer = setTimeout(() => {
        if (state.qrBuffer.length >= CONFIG.qr.minLength && 
            state.qrBuffer.length <= CONFIG.qr.maxLength &&
            !isConsoleOutput(state.qrBuffer)) {
          
          const qrCode = state.qrBuffer;
          state.qrBuffer = '';
          log(`✅ QR auto-detected: ${qrCode}`, 'success');
          
          processQRCode(qrCode).catch(error => {
            log(`QR async error: ${error.message}`, 'error');
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
  
  log('✅ Keyboard listener ready!', 'success');
}

// ============================================
// HEALTH CHECKS
// ============================================

function checkScannerHealth() {
  const now = Date.now();
  const timeSinceActivity = now - state.lastKeyboardActivity;
  
  log('🏥 Scanner Health:', 'qr');
  log(`   isReady: ${state.isReady}`, 'qr');
  log(`   autoCycle: ${state.autoCycleEnabled}`, 'qr');
  log(`   processingQR: ${state.processingQR}`, 'qr');
  log(`   resetting: ${state.resetting}`, 'qr');
  log(`   keyboardActive: ${state.globalKeyListener ? 'YES' : 'NO'}`, 'qr');
  log(`   lastActivity: ${Math.round(timeSinceActivity/1000)}s ago`, 'qr');
  
  // Check 1: Stuck processing flag
  if (state.processingQR && state.processingQRTimeout === null) {
    log('⚠️ processingQR stuck without timeout!', 'warning');
    clearQRProcessing();
  }
  
  // Check 2: Keyboard listener died
  if (!state.globalKeyListener && state.isReady && !state.autoCycleEnabled) {
    log('⚠️ Keyboard listener missing - recreating!', 'warning');
    setupQRScanner();
  }
  
  // Check 3: No activity for too long (only when not in session)
  if (!state.autoCycleEnabled && state.isReady && timeSinceActivity > 180000) {
    log('⚠️ No keyboard activity for 3+ minutes - listener may be dead', 'warning');
    log('🔄 Restarting keyboard listener...', 'warning');
    
    if (state.globalKeyListener) {
      try {
        state.globalKeyListener.kill();
      } catch (e) {
        // Ignore
      }
      state.globalKeyListener = null;
    }
    
    setupQRScanner();
    state.lastKeyboardActivity = Date.now();
  }
  
  const canScan = canAcceptQRScan();
  log(`   ${canScan ? '✅ READY FOR SCAN' : '❌ NOT READY'}`, 'qr');
  log('━'.repeat(50), 'qr');
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
    
    log(`💓 Heartbeat started: ${this.timeout}s`, 'info');
    log(`🔍 Health checks: ${CONFIG.heartbeat.stateCheckInterval}s`, 'info');
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
          log('========================================');
          log('🟢 SYSTEM READY');
          log('========================================');
          log(`📱 Module ID: ${state.moduleId}`);
          log('========================================\n');
          
          setupQRScanner();
          
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status: 'ready',
            event: 'startup_ready',
            moduleId: state.moduleId,
            isReady: true,
            timestamp
          }));
          
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
      canAcceptQRScan: canAcceptQRScan(),
      processingQR: state.processingQR,
      keyboardListenerActive: state.globalKeyListener !== null,
      compactorRunning: state.compactorRunning,
      lastCycleTime: state.lastCycleTime,
      timestamp
    }));
    
    const scanStatus = canAcceptQRScan() ? '🟢 READY' : '🔴 BUSY';
    const compactorStatus = state.compactorRunning ? '🔨 CRUSHING' : '⭕ IDLE';
    const perfInfo = state.lastCycleTime ? ` | ${(state.lastCycleTime/1000).toFixed(1)}s` : '';
    
    console.log(`💓 ${state.isReady ? '🟢' : '🟡'} | ` +
                `Module: ${state.moduleId || 'NONE'} | ` +
                `Session: ${state.autoCycleEnabled ? 'ACTIVE' : 'IDLE'} | ` +
                `Scanner: ${scanStatus} | ` +
                `Compactor: ${compactorStatus}${perfInfo}`);
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
  console.log('🔬 SYSTEM DIAGNOSTICS');
  console.log('='.repeat(60));
  
  console.log('\n📱 QR Scanner:');
  console.log(`   Keyboard listener: ${state.globalKeyListener ? '✅ ACTIVE' : '❌ INACTIVE'}`);
  console.log(`   Processing QR: ${state.processingQR ? '⏳ YES' : '✅ NO'}`);
  console.log(`   Can accept scan: ${canAcceptQRScan() ? '✅ YES' : '❌ NO'}`);
  console.log(`   Buffer: "${state.qrBuffer}"`);
  console.log(`   Last activity: ${Math.round((Date.now() - state.lastKeyboardActivity)/1000)}s ago`);
  
  console.log('\n🎯 System:');
  console.log(`   isReady: ${state.isReady}`);
  console.log(`   autoCycle: ${state.autoCycleEnabled}`);
  console.log(`   resetting: ${state.resetting}`);
  console.log(`   moduleId: ${state.moduleId}`);
  console.log(`   compactorRunning: ${state.compactorRunning}`);
  
  console.log('\n' + '='.repeat(60) + '\n');
}

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
      log(`${materialType} (${confidencePercent}% - keyword match)`, 'success');
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
// CONTINUOUS COMPACTOR - SIMPLE!
// ============================================
async function startContinuousCompactor() {
  if (state.compactorRunning) {
    log('✅ Compactor already running continuously', 'info');
    return;
  }
  
  log('🔨 Starting continuous compactor', 'info');
  
  try {
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    state.compactorRunning = true;
    log('✅ Compactor running continuously - will crush all bottles!', 'success');
    
  } catch (error) {
    log(`❌ Failed to start compactor: ${error.message}`, 'error');
    state.compactorRunning = false;
    throw error;
  }
}

async function stopContinuousCompactor() {
  if (!state.compactorRunning) {
    log('✅ Compactor already stopped', 'info');
    return;
  }
  
  log('🛑 Stopping continuous compactor', 'info');
  
  try {
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    state.compactorRunning = false;
    log('✅ Compactor stopped', 'success');
    
  } catch (error) {
    log(`❌ Failed to stop compactor: ${error.message}`, 'error');
    state.compactorRunning = false;
  }
}

// ============================================
// CYCLE OPERATIONS
// ============================================
async function executeRejectionCycle() {
  console.log('\n' + '='.repeat(50));
  console.log('❌ REJECTION CYCLE');
  console.log('='.repeat(50) + '\n');

  try {
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    mqttClient.publish('rvm/RVM-3101/item/rejected', JSON.stringify({
      deviceId: CONFIG.device.id,
      reason: 'LOW_CONFIDENCE',
      userId: state.currentUserId,
      sessionCode: state.sessionCode,
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

  // GATE STAYS OPEN - just continue detection
  if (state.autoCycleEnabled) {
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
}

async function executeAutoCycle() {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    state.cycleInProgress = false;
    return;
  }

  const cycleStartTime = Date.now();
  state.itemsProcessed++;
  
  const cycleData = {
    deviceId: CONFIG.device.id,
    material: state.aiResult.materialType,
    weight: state.weight.weight,
    userId: state.currentUserId,
    sessionCode: state.sessionCode,
    itemNumber: state.itemsProcessed,
    timestamp: new Date().toISOString()
  };
  
  console.log('\n' + '='.repeat(50));
  console.log(`⚡ CYCLE #${state.itemsProcessed}`);
  console.log('='.repeat(50) + '\n');

  try {
    // Move belt to stepper
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    // Rotate stepper to target position
    const targetPosition = cycleData.material === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    log(`🔄 Moving stepper to ${cycleData.material} position...`, 'info');
    await executeCommand('stepperMotor', { position: targetPosition });
    await delay(CONFIG.timing.stepperRotate);

    // Reverse belt to drop item INTO RUNNING COMPACTOR
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

    // Reset stepper to home position
    log('🔄 Resetting stepper to home...', 'info');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    log('✅ Stepper at home position', 'success');

    // 🚨 NO COMPACTOR START - it's already running continuously!
    log('🔨 Bottle dropped into running compactor', 'success');

    mqttClient.publish(CONFIG.mqtt.topics.cycleComplete, JSON.stringify(cycleData));

    trackCycleTime(cycleStartTime);
    resetInactivityTimer();

  } catch (error) {
    log(`Cycle error: ${error.message}`, 'error');
  }

  // Clear cycle state - ready for next bottle immediately
  state.aiResult = null;
  state.weight = null;
  state.cycleInProgress = false;
  state.detectionRetries = 0;
  state.awaitingDetection = false;

  // GATE STAYS OPEN - start next detection immediately
  if (state.autoCycleEnabled) {
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    // Start looking for next item immediately
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
}

// ============================================
// SESSION MANAGEMENT
// ============================================
async function startMemberSession(validationData) {
  console.log('\n' + '='.repeat(50));
  console.log('🎬 MEMBER SESSION START');
  console.log('='.repeat(50));
  
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
    
    // 🚨 START CONTINUOUS COMPACTOR
    await startContinuousCompactor();
    
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.resetHomeDelay);
    
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationDelay);
    
    // OPEN GATE ONCE - stays open for entire session
    await executeCommand('openGate');
    await delay(CONFIG.timing.commandDelay);
    log('🚪 Gate opened for session', 'success');
    
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'session_active',
      message: 'Insert your items',
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
    
    log('⚡ Session started with continuous compactor!', 'success');
    
  } catch (error) {
    log(`❌ Session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function startGuestSession(sessionData) {
  console.log('\n' + '='.repeat(50));
  console.log('🎬 GUEST SESSION START');
  console.log('='.repeat(50));
  
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
    
    // 🚨 START CONTINUOUS COMPACTOR
    await startContinuousCompactor();
    
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.resetHomeDelay);
    
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationDelay);
    
    // OPEN GATE ONCE - stays open for entire session
    await executeCommand('openGate');
    await delay(CONFIG.timing.commandDelay);
    log('🚪 Gate opened for session', 'success');
    
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
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
    }
    
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
    
    log('⚡ Guest session started with continuous compactor!', 'success');
    
  } catch (error) {
    log(`❌ Session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function resetSystemForNextUser(forceStop = false) {
  console.log('\n' + '='.repeat(50));
  console.log('🔄 RESET FOR NEXT USER');
  console.log('='.repeat(50) + '\n');
  
  if (state.resetting) {
    return;
  }
  
  state.resetting = true;
  
  try {
    state.autoCycleEnabled = false;
    state.awaitingDetection = false;
    
    if (state.autoPhotoTimer) {
      clearTimeout(state.autoPhotoTimer);
      state.autoPhotoTimer = null;
    }
    
    // Wait for current cycle to complete
    if (state.cycleInProgress) {
      const maxWait = 60000;
      const startWait = Date.now();
      
      log('⏳ Waiting for current cycle to complete...', 'info');
      
      while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
        await delay(2000);
      }
    }
    
    // 🚨 STOP CONTINUOUS COMPACTOR
    await stopContinuousCompactor();
    
    // CLOSE GATE - session ended
    await executeCommand('closeGate');
    await delay(CONFIG.timing.commandDelay);
    log('🚪 Gate closed', 'success');
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);

  } catch (error) {
    log(`Reset error: ${error.message}`, 'error');
  } finally {
    // Reset all state
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
    
    clearSessionTimers();
    
    // Clear QR processing state
    clearQRProcessing();
    
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
      state: 'ready_for_qr',
      message: 'Please scan your QR code',
      timestamp: new Date().toISOString()
    }));
    
    log('✅ System ready - QR scanner active', 'success');
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
// MQTT & WEBSOCKET
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
        log(`✅ Module ID: ${state.moduleId}`, 'success');
        
        heartbeat.moduleIdRetries = 0;
        
        if (!state.isReady) {
          state.isReady = true;
          log('========================================');
          log('🟢 SYSTEM READY');
          log('========================================');
          
          setupQRScanner();
          
          mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
            deviceId: CONFIG.device.id,
            status: 'ready',
            moduleId: state.moduleId,
            isReady: true,
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
            setTimeout(() => executeCommand('getWeight'), CONFIG.timing.calibrationDelay);
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

const mqttClient = mqtt.connect(CONFIG.mqtt.brokerUrl, {
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  ca: fs.readFileSync(CONFIG.mqtt.caFile),
  rejectUnauthorized: false
});

mqttClient.on('connect', () => {
  log('✅ MQTT connected', 'success');
  
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
        log('📊 Status request received', 'info');
        
        mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
          deviceId: CONFIG.device.id,
          status: state.isReady ? 'ready' : 'initializing',
          event: 'status_response',
          isReady: state.isReady,
          autoCycleEnabled: state.autoCycleEnabled,
          resetting: state.resetting,
          processingQR: state.processingQR,
          compactorRunning: state.compactorRunning,
          moduleId: state.moduleId,
          timestamp: new Date().toISOString()
        }));
        
        return;
      }
      
      if (payload.action === 'emergencyStop') {
        await executeCommand('closeGate');
        await executeCommand('customMotor', CONFIG.motors.belt.stop);
        
        // Stop compactor
        await stopContinuousCompactor();
        
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

// ============================================
// SHUTDOWN
// ============================================
function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...\n');
  
  clearQRProcessing();
  heartbeat.stop();
  
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  
  clearSessionTimers();
  
  if (state.globalKeyListener) {
    try {
      state.globalKeyListener.kill();
    } catch (e) {
      // Ignore
    }
  }
  
  // Stop compactor on shutdown
  if (state.compactorRunning) {
    executeCommand('customMotor', CONFIG.motors.compactor.stop).catch(() => {});
  }
  
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
console.log('='.repeat(60));
console.log('🚀 RVM AGENT - CONTINUOUS COMPACTOR');
console.log('='.repeat(60));
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('✅ Gate stays open during session!');
console.log('✅ Compactor runs continuously!');
console.log('✅ All bottles crushed automatically!');
console.log('✅ Maximum throughput!');
console.log('='.repeat(60) + '\n');

log('🚀 Starting agent with continuous compactor...', 'info');