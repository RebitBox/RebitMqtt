// agent-qr-ultra-reliable-optimized-v2.js - EXACT TIMINGS FROM V1
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const { GlobalKeyboardListener } = require('node-global-key-listener');

// ============================================
// CONFIGURATION - EXACT TIMINGS FROM V1
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
    debug: true,
    restartAfterSession: true,
    healthCheckInterval: 15000
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
    minValidWeight: 5,
    minConfidenceRetry: 0.15
  },
  
  timing: {
    beltToWeight: 2500,
    beltToStepper: 2800,
    beltReverse: 4000,
    stepperRotate: 2500,
    stepperReset: 3500,
    compactorCycle: 22000,
    compactorIdleStop: 8000,
    positionSettle: 300,
    gateOperation: 800,
    autoPhotoDelay: 2500,
    sessionTimeout: 120000,
    sessionMaxDuration: 600000,
    weightDelay: 1200,
    photoDelay: 1000,
    calibrationDelay: 1000,
    commandDelay: 100,
    resetHomeDelay: 1200,
    itemDropDelay: 800
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
  scannerHealthTimer: null,
  lastScannerRestart: Date.now(),
  
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
  
  // Continuous compactor state
  compactorRunning: false,
  compactorTimer: null,
  compactorIdleTimer: null,
  lastItemTime: null,
  
  autoPhotoTimer: null,
  detectionRetries: 0,
  awaitingDetection: false,
  resetting: false,
  
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
  
  // Detection analytics
  detectionStats: {
    totalAttempts: 0,
    firstTimeSuccess: 0,
    secondTimeSuccess: 0,
    thirdTimeSuccess: 0,
    failures: 0,
    averageRetries: 0,
    lastSuccessfulTiming: null
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
    'qr': '📱',
    'crusher': '🔨',
    'camera': '📸',
    'detection': '🎯'
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
  const secondTimeRate = ((stats.secondTimeSuccess / total) * 100).toFixed(1);
  
  log('\n' + '='.repeat(60), 'detection');
  log('📊 DETECTION STATISTICS', 'detection');
  log('='.repeat(60), 'detection');
  log(`Total Attempts: ${stats.totalAttempts}`, 'detection');
  log(`First Time Success: ${stats.firstTimeSuccess} (${firstTimeRate}%)`, 'detection');
  log(`Second Time Success: ${stats.secondTimeSuccess} (${secondTimeRate}%)`, 'detection');
  log(`Third Time Success: ${stats.thirdTimeSuccess}`, 'detection');
  log(`Failures: ${stats.failures}`, 'detection');
  log(`Average Retries: ${stats.averageRetries.toFixed(2)}`, 'detection');
  log('='.repeat(60) + '\n', 'detection');
}

// ============================================
// QR SCANNER
// ============================================

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

function forceRestartScanner() {
  log('🔄 Force restarting QR scanner...', 'warning');
  
  clearQRProcessing();
  
  if (state.globalKeyListener) {
    try {
      state.globalKeyListener.kill();
    } catch (e) {
      log(`Error killing listener: ${e.message}`, 'error');
    }
    state.globalKeyListener = null;
  }
  
  setTimeout(() => {
    log('✅ Creating fresh QR scanner...', 'success');
    setupQRScanner();
  }, 1000);
}

function testScannerHealth() {
  if (!state.globalKeyListener) {
    return false;
  }
  
  const timeSinceActivity = Date.now() - state.lastKeyboardActivity;
  const timeSinceRestart = Date.now() - state.lastScannerRestart;
  
  if (timeSinceActivity > 180000 && timeSinceRestart > 30000 && !state.autoCycleEnabled) {
    log('⚠️ Scanner appears unresponsive - no activity for 3+ min', 'warning');
    return false;
  }
  
  return true;
}

function startScannerHealthMonitor() {
  if (state.scannerHealthTimer) {
    clearInterval(state.scannerHealthTimer);
  }
  
  state.scannerHealthTimer = setInterval(() => {
    if (!testScannerHealth() && canAcceptQRScan()) {
      log('💊 Auto-healing QR scanner...', 'warning');
      forceRestartScanner();
    }
  }, CONFIG.qr.healthCheckInterval);
  
  log(`💊 Scanner health monitor started (${CONFIG.qr.healthCheckInterval}ms)`, 'info');
}

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

async function processQRCode(qrData) {
  if (!canAcceptQRScan()) {
    debugLog('QR rejected - system not ready for scan');
    return;
  }
  
  const cleanCode = qrData.replace(/[\r\n\t]/g, '').trim();
  
  if (cleanCode.length < CONFIG.qr.minLength || cleanCode.length > CONFIG.qr.maxLength) {
    log(`Invalid QR length: ${cleanCode.length}`, 'error');
    return;
  }
  
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
    log(`❌ QR error: ${error.message}`, 'error');
    
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
    log('✅ QR processing complete', 'qr');
  }
}

function createKeyboardListener() {
  console.log('\n' + '='.repeat(50));
  console.log('📱 QR SCANNER - CREATING NEW LISTENER');
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
  
  try {
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
          
          log(`✅ QR detected (ENTER): ${qrCode}`, 'success');
          
          processQRCode(qrCode).catch(error => {
            log(`QR async error: ${error.message}`, 'error');
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
        debugLog(`Buffer: "${state.qrBuffer}"`);
        
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
    state.lastScannerRestart = Date.now();
    state.lastKeyboardActivity = Date.now();
    
    log('✅ Keyboard listener created successfully!', 'success');
    
  } catch (error) {
    log(`❌ Failed to create keyboard listener: ${error.message}`, 'error');
    state.globalKeyListener = null;
  }
}

function setupQRScanner() {
  if (!CONFIG.qr.enabled) {
    log('QR scanner disabled', 'warning');
    return;
  }
  
  if (state.globalKeyListener) {
    try {
      log('🔄 Stopping existing keyboard listener...', 'warning');
      state.globalKeyListener.kill();
      state.globalKeyListener = null;
    } catch (e) {
      log(`Error killing listener: ${e.message}`, 'error');
      state.globalKeyListener = null;
    }
    
    setTimeout(() => {
      createKeyboardListener();
    }, 800);
    return;
  }
  
  createKeyboardListener();
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
    log('🔨 Compactor already running - continuing', 'crusher');
    resetCompactorIdleTimer();
    return;
  }
  
  log('🔨 Starting continuous compactor', 'crusher');
  
  try {
    await executeCommand('customMotor', CONFIG.motors.compactor.start);
    state.compactorRunning = true;
    state.lastItemTime = Date.now();
    
    log('✅ Compactor started - will run until idle', 'crusher');
    
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
  
  debugLog(`🔨 Compactor idle timer reset (${CONFIG.timing.compactorIdleStop}ms)`);
}

async function stopCompactor() {
  if (!state.compactorRunning) {
    return;
  }
  
  try {
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
    log('✅ Compactor stopped', 'crusher');
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
// HEALTH CHECKS
// ============================================

function checkScannerHealth() {
  const now = Date.now();
  const timeSinceActivity = now - state.lastKeyboardActivity;
  const timeSinceRestart = now - state.lastScannerRestart;
  
  log('🏥 Scanner Health:', 'qr');
  log(`   isReady: ${state.isReady}`, 'qr');
  log(`   autoCycle: ${state.autoCycleEnabled}`, 'qr');
  log(`   processingQR: ${state.processingQR}`, 'qr');
  log(`   resetting: ${state.resetting}`, 'qr');
  log(`   keyboardActive: ${state.globalKeyListener ? 'YES' : 'NO'}`, 'qr');
  log(`   lastActivity: ${Math.round(timeSinceActivity/1000)}s ago`, 'qr');
  log(`   lastRestart: ${Math.round(timeSinceRestart/1000)}s ago`, 'qr');
  log(`   compactorRunning: ${state.compactorRunning}`, 'qr');
  
  if (state.processingQR && state.processingQRTimeout === null) {
    log('⚠️ processingQR stuck without timeout!', 'warning');
    clearQRProcessing();
  }
  
  if (!state.globalKeyListener && state.isReady && !state.autoCycleEnabled) {
    log('⚠️ Keyboard listener missing - recreating!', 'warning');
    setupQRScanner();
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
    
    startScannerHealthMonitor();
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
    
    if (state.scannerHealthTimer) {
      clearInterval(state.scannerHealthTimer);
      state.scannerHealthTimer = null;
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
      detectionStats: state.detectionStats,
      timestamp
    }));
    
    const scanStatus = canAcceptQRScan() ? '🟢 READY' : '🔴 BUSY';
    const compactorStatus = state.compactorRunning ? '🔨 CRUSHING' : '⚪ IDLE';
    const perfInfo = state.lastCycleTime ? ` | ${(state.lastCycleTime/1000).toFixed(1)}s` : '';
    const detectionInfo = state.detectionStats.totalAttempts > 0 ? 
      ` | 1st:${((state.detectionStats.firstTimeSuccess/state.detectionStats.totalAttempts)*100).toFixed(0)}%` : '';
    
    console.log(`💓 ${state.isReady ? '🟢' : '🟡'} | ` +
                `Module: ${state.moduleId || 'NONE'} | ` +
                `Session: ${state.autoCycleEnabled ? 'ACTIVE' : 'IDLE'} | ` +
                `Scanner: ${scanStatus} | ` +
                `Compactor: ${compactorStatus}${perfInfo}${detectionInfo}`);
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
  console.log(`   Last restart: ${Math.round((Date.now() - state.lastScannerRestart)/1000)}s ago`);
  
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
  
  console.log('\n' + '='.repeat(60) + '\n');
  
  logDetectionStats();
}

// ============================================
// MATERIAL TYPE DETECTION - IMPROVED VERSION
// ============================================
function determineMaterialType(aiData) {
  const className = (aiData.className || '').toLowerCase();
  const probability = aiData.probability || 0;
  
  log(`\n🔍 AI DETECTION ANALYSIS:`, 'detection');
  log(`   Raw className: "${aiData.className}"`, 'detection');
  log(`   Probability: ${(probability * 100).toFixed(2)}%`, 'detection');
  
  let materialType = 'UNKNOWN';
  let threshold = 1.0;
  let hasStrongKeyword = false;
  
  // New format: "1-Can" or "0-PET"
  if (className.includes('1-can') || className === '1-can') {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = true;
    log(`   ✅ New format detected: METAL_CAN`, 'detection');
  } 
  else if (className.includes('0-pet') || className === '0-pet') {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = true;
    log(`   ✅ New format detected: PLASTIC_BOTTLE`, 'detection');
  }
  // Legacy format support
  else if (className.includes('易拉罐') || className.includes('metal') || 
           className.includes('can') || className.includes('铝')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
    hasStrongKeyword = className.includes('易拉罐') || className.includes('铝');
    log(`   ✅ Legacy format detected: METAL_CAN`, 'detection');
  } 
  else if (className.includes('pet') || className.includes('plastic') || 
           className.includes('瓶') || className.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
    hasStrongKeyword = className.includes('pet');
    log(`   ✅ Legacy format detected: PLASTIC_BOTTLE`, 'detection');
  } 
  else if (className.includes('玻璃') || className.includes('glass')) {
    materialType = 'GLASS';
    threshold = CONFIG.detection.GLASS;
    hasStrongKeyword = className.includes('玻璃');
    log(`   ✅ Legacy format detected: GLASS`, 'detection');
  }
  
  const confidencePercent = Math.round(probability * 100);
  
  log(`   Material: ${materialType}`, 'detection');
  log(`   Threshold: ${Math.round(threshold * 100)}%`, 'detection');
  log(`   Strong keyword: ${hasStrongKeyword}`, 'detection');
  
  // Check for very low confidence that warrants immediate retry
  if (probability < CONFIG.detection.minConfidenceRetry && materialType === 'UNKNOWN') {
    log(`   ⚠️ VERY LOW confidence (${confidencePercent}%) - likely bad photo`, 'warning');
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    const relaxedThreshold = threshold * 0.3;
    
    if (hasStrongKeyword && probability >= relaxedThreshold) {
      log(`   ✅ ACCEPTED via keyword (${confidencePercent}% >= ${Math.round(relaxedThreshold * 100)}%)`, 'success');
      return materialType;
    }
    
    log(`   ❌ REJECTED - Low confidence (${confidencePercent}% < ${Math.round(threshold * 100)}%)`, 'warning');
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN') {
    log(`   ✅ ACCEPTED - ${materialType} (${confidencePercent}%)`, 'success');
  } else {
    log(`   ❌ UNKNOWN material`, 'warning');
  }
  
  log(`${'─'.repeat(50)}\n`, 'detection');
  
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
// REJECTION CYCLE
// ============================================
async function executeRejectionCycle() {
  console.log('\n' + '='.repeat(50));
  console.log('❌ REJECTION CYCLE - REVERSING BELT');
  console.log('='.repeat(50) + '\n');

  try {
    log('⚠️ Reversing belt to reject item', 'warning');
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    log('✅ Item rejected', 'crusher');

    trackDetectionAttempt(false, state.detectionRetries);

    mqttClient.publish('rvm/RVM-3101/item/rejected', JSON.stringify({
      deviceId: CONFIG.device.id,
      reason: 'LOW_CONFIDENCE',
      userId: state.currentUserId,
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
  
  const cycleData = {
    deviceId: CONFIG.device.id,
    material: state.aiResult.materialType,
    weight: state.weight.weight,
    userId: state.currentUserId,
    sessionCode: state.sessionCode,
    itemNumber: state.itemsProcessed,
    detectionRetries: state.detectionRetries,
    timestamp: new Date().toISOString()
  };
  
  console.log('\n' + '='.repeat(50));
  console.log(`⚡ CYCLE #${state.itemsProcessed} - MAXIMUM SPEED`);
  console.log(`   Material: ${cycleData.material}`);
  console.log(`   Weight: ${cycleData.weight}g`);
  console.log(`   Detection tries: ${state.detectionRetries + 1}`);
  console.log('='.repeat(50) + '\n');

  try {
    await startContinuousCompactor();
    
    log('⚡ Moving belt to stepper...', 'info');
    await executeCommand('customMotor', CONFIG.motors.belt.toStepper);
    await delay(CONFIG.timing.beltToStepper);
    
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    log('✅ Belt stopped - item will drop by gravity', 'success');

    const targetPosition = cycleData.material === 'METAL_CAN' 
      ? CONFIG.motors.stepper.positions.metalCan
      : CONFIG.motors.stepper.positions.plasticBottle;
    
    log(`🔄 Stepper → ${cycleData.material}...`, 'info');
    await executeCommand('stepperMotor', { position: targetPosition });
    await delay(CONFIG.timing.stepperRotate);

    log('⏳ Waiting for gravity drop...', 'info');
    await delay(CONFIG.timing.itemDropDelay);

    log('🔄 Stepper → home...', 'info');
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.stepperReset);
    log('✅ Stepper at home', 'success');

    log('🔨 Compactor crushing continuously...', 'crusher');

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

// ============================================
// SESSION MANAGEMENT
// ============================================
async function startMemberSession(validationData) {
  console.log('\n' + '='.repeat(50));
  console.log('🎬 MEMBER SESSION START - MAXIMUM SPEED MODE');
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
    
    await stopCompactor();
    
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.resetHomeDelay);
    
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationDelay);
    
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
    
    log('⚡ Session started - Maximum speed mode!', 'success');
    
  } catch (error) {
    log(`❌ Session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true);
    throw error;
  }
}

async function startGuestSession(sessionData) {
  console.log('\n' + '='.repeat(50));
  console.log('🎬 GUEST SESSION START - MAXIMUM SPEED MODE');
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
    
    await stopCompactor();
    
    await executeCommand('stepperMotor', { position: CONFIG.motors.stepper.positions.home });
    await delay(CONFIG.timing.resetHomeDelay);
    
    await executeCommand('calibrateWeight');
    await delay(CONFIG.timing.calibrationDelay);
    
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
    
    log('⚡ Guest session started - Maximum speed mode!', 'success');
    
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
    
    if (state.cycleInProgress) {
      const maxWait = 60000;
      const startWait = Date.now();
      
      log('⏳ Waiting for current cycle to complete...', 'info');
      
      while (state.cycleInProgress && (Date.now() - startWait) < maxWait) {
        await delay(2000);
      }
    }
    
    if (forceStop) {
      log('🛑 Force stopping compactor', 'warning');
      await stopCompactor();
    } else {
      if (state.compactorRunning) {
        log('⏳ Compactor finishing current cycle...', 'info');
        await delay(2000);
        await stopCompactor();
      }
    }
    
    await executeCommand('closeGate');
    await delay(CONFIG.timing.commandDelay);
    log('🚪 Gate closed', 'success');
    
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
    state.lastItemTime = null;
    
    clearSessionTimers();
    clearQRProcessing();
    
    state.resetting = false;
    state.isReady = true;
    
    if (CONFIG.qr.restartAfterSession) {
      log('🔄 Restarting QR scanner after session...', 'warning');
      setTimeout(() => {
        forceRestartScanner();
      }, 1500);
    }
    
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
          log('🟢 SYSTEM READY - MAXIMUM SPEED MODE');
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
              
              setTimeout(async () => {
                try {
                  await executeCommand('getWeight');
                  await delay(CONFIG.timing.weightDelay + 500);
                  
                  if (state.weight && state.weight.weight >= CONFIG.detection.minValidWeight) {
                    state.cycleInProgress = true;
                    setTimeout(() => executeRejectionCycle(), 500);
                  } else {
                    log('No item detected - skipping rejection', 'crusher');
                    state.aiResult = null;
                    state.weight = null;
                    state.detectionRetries = 0;
                    
                    if (state.autoCycleEnabled) {
                      state.autoPhotoTimer = setTimeout(() => {
                        if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
                          state.awaitingDetection = true;
                          executeCommand('takePhoto');
                        }
                      }, CONFIG.timing.autoPhotoDelay);
                    }
                  }
                } catch (error) {
                  log(`Weight check error: ${error.message}`, 'error');
                  state.aiResult = null;
                  state.weight = null;
                  state.detectionRetries = 0;
                  state.awaitingDetection = false;
                }
              }, 300);
            }
          }
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
          4: { name: 'Infrared Sensor', key: null, critical: false }
        };
        
        const binInfo = binStatusMap[binCode];
        
        if (binInfo) {
          log(`⚠️ BIN STATUS: ${binInfo.name} bin full (code: ${binCode})`, 'warning');
          
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
            log(`Critical bin full: ${binInfo.name}`, 'warning');
            
            const currentMaterialBin = state.aiResult?.materialType === 'METAL_CAN' ? 'metal' : 'plastic';
            
            if (binInfo.key === currentMaterialBin) {
              log('Current material bin is full - ending session', 'warning');
              
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
          detectionStats: state.detectionStats,
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
        await resetSystemForNextUser(false);
        return;
      }
      
      if (payload.action === 'runDiagnostics') {
        runDiagnostics();
        return;
      }
      
      if (payload.action === 'restartScanner') {
        log('🔄 Manual scanner restart requested', 'info');
        forceRestartScanner();
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
        
        log('🗑️ Bin status reset', 'success');
        
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

// ============================================
// SHUTDOWN
// ============================================
function gracefulShutdown() {
  console.log('\n⏹️ Shutting down...\n');
  
  clearQRProcessing();
  heartbeat.stop();
  
  stopCompactor();
  
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  
  clearSessionTimers();
  
  if (state.globalKeyListener) {
    try {
      state.globalKeyListener.kill();
    } catch (e) {
      // Ignore
    }
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
console.log('🚀 RVM AGENT V2 - MAXIMUM SPEED WITH IMPROVED DETECTION');
console.log('='.repeat(60));
console.log(`📱 Device: ${CONFIG.device.id}`);
console.log('✅ Gate stays open during session!');
console.log('🔨 Compactor runs continuously!');
console.log('⚡ No belt reverse for accepted items!');
console.log('⚡ Items drop by gravity!');
console.log('🎯 Enhanced material detection!');
console.log('📊 Detection analytics tracking!');
console.log('💊 Auto-healing QR scanner!');
console.log('='.repeat(60) + '\n');

log('🚀 Starting optimized agent with v1 timings...', 'info');