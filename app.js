// agent-production.js - Production Optimized
const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');
const WebSocket = require('ws');
const { GlobalKeyboardListener } = require('node-global-key-listener');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  device: { id: 'RVM-3101' },
  backend: { url: 'https://app.rebit-japan.com/', timeout: 8000 },
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
      cycleComplete: 'rvm/RVM-3101/cycle/complete',
      aiResult: 'rvm/RVM-3101/ai/result',
      weightResult: 'rvm/RVM-3101/weight/result',
      status: 'rvm/RVM-3101/status',
      screenState: 'rvm/RVM-3101/screen/state',
      qrInput: 'rvm/RVM-3101/qr/input',
      guestStart: 'rvm/RVM-3101/guest/start',
      binStatus: 'rvm/RVM-3101/bin/status',
      itemRejected: 'rvm/RVM-3101/item/rejected'
    }
  },
  qr: {
    enabled: true,
    minLength: 5,
    maxLength: 50,
    scanTimeout: 200,
    processingTimeout: 25000,
    restartAfterSession: true,
    healthCheckInterval: 15000
  },
  motors: {
    belt: {
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
    retryDelay: 1500,
    maxRetries: 2,
    minValidWeight: 5,
    minConfidenceRetry: 0.15
  },
  timing: {
    beltToStepper: 2800,
    beltReverse: 4000,
    stepperRotate: 2500,
    stepperReset: 3500,
    compactorIdleStop: 8000,
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
  weight: { coefficients: { 1: 988, 2: 942, 3: 942, 4: 942 } }
};

// ============================================
// STATE
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
  qrBuffer: '',
  lastCharTime: 0,
  qrTimer: null,
  processingQR: false,
  processingQRTimeout: null,
  globalKeyListener: null,
  lastKeyboardActivity: Date.now(),
  scannerHealthTimer: null,
  lastScannerRestart: Date.now(),
  sessionId: null,
  sessionCode: null,
  currentUserId: null,
  currentUserData: null,
  isMember: false,
  itemsProcessed: 0,
  sessionStartTime: null,
  sessionTimeoutTimer: null,
  maxDurationTimer: null,
  compactorRunning: false,
  compactorIdleTimer: null,
  lastItemTime: null,
  autoPhotoTimer: null,
  detectionRetries: 0,
  awaitingDetection: false,
  resetting: false,
  binStatus: { plastic: false, metal: false, right: false, glass: false },
  stats: {
    totalAttempts: 0,
    firstSuccess: 0,
    secondSuccess: 0,
    thirdSuccess: 0,
    failures: 0
  }
};

// ============================================
// UTILITIES
// ============================================
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const log = (msg, level = 'info') => {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  console.log(`[${new Date().toISOString()}] ${icons[level] || 'ℹ️'} ${msg}`);
};

// ============================================
// QR SCANNER
// ============================================
const canAcceptQRScan = () => 
  state.isReady && !state.autoCycleEnabled && !state.processingQR && !state.resetting;

const clearQRProcessing = () => {
  if (state.processingQRTimeout) clearTimeout(state.processingQRTimeout);
  if (state.qrTimer) clearTimeout(state.qrTimer);
  state.processingQRTimeout = null;
  state.qrTimer = null;
  state.processingQR = false;
  state.qrBuffer = '';
};

const forceRestartScanner = () => {
  clearQRProcessing();
  if (state.globalKeyListener) {
    try { state.globalKeyListener.kill(); } catch (e) {}
    state.globalKeyListener = null;
  }
  setTimeout(setupQRScanner, 1000);
};

const startScannerHealthMonitor = () => {
  if (state.scannerHealthTimer) clearInterval(state.scannerHealthTimer);
  state.scannerHealthTimer = setInterval(() => {
    const timeSinceActivity = Date.now() - state.lastKeyboardActivity;
    const timeSinceRestart = Date.now() - state.lastScannerRestart;
    if (timeSinceActivity > 180000 && timeSinceRestart > 30000 && 
        !state.autoCycleEnabled && canAcceptQRScan()) {
      log('QR scanner auto-healing', 'warning');
      forceRestartScanner();
    }
  }, CONFIG.qr.healthCheckInterval);
};

const validateQRWithBackend = async (sessionCode) => {
  try {
    const response = await axios.post(
      `${CONFIG.backend.url}/api/rvm/${CONFIG.device.id}/qr/validate`,
      { sessionCode },
      { timeout: CONFIG.backend.timeout, headers: { 'Content-Type': 'application/json' }}
    );
    return response.data.success ? 
      { valid: true, user: response.data.user, session: response.data.session } :
      { valid: false, error: response.data.error || 'Invalid QR' };
  } catch (error) {
    return { valid: false, error: error.response?.data?.error || 'Network error' };
  }
};

const processQRCode = async (qrData) => {
  if (!canAcceptQRScan()) return;
  
  const cleanCode = qrData.replace(/[\r\n\t]/g, '').trim();
  if (cleanCode.length < CONFIG.qr.minLength || cleanCode.length > CONFIG.qr.maxLength) return;
  
  state.processingQR = true;
  state.processingQRTimeout = setTimeout(() => {
    log('QR timeout', 'warning');
    clearQRProcessing();
  }, CONFIG.qr.processingTimeout);
  
  try {
    mqttClient.publish(CONFIG.mqtt.topics.screenState, JSON.stringify({
      deviceId: CONFIG.device.id,
      state: 'qr_validating',
      message: 'Validating...',
      timestamp: new Date().toISOString()
    }));
    
    const validation = await validateQRWithBackend(cleanCode);
    
    if (validation.valid) {
      log(`QR validated: ${validation.user.name}`, 'success');
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
  }
};

const createKeyboardListener = () => {
  const CONSOLE_PATTERNS = [
    /^C:\\/i, /^[A-Z]:\\/i, /operable program/i, /batch file/i,
    /Users\\/i, /\\rebit-mqtt/i, /node/i, /RVM AGENT/i
  ];
  
  const isConsoleOutput = text => CONSOLE_PATTERNS.some(p => p.test(text));
  
  try {
    const gkl = new GlobalKeyboardListener();
    gkl.addListener((e, down) => {
      if (e.state !== 'DOWN') return;
      state.lastKeyboardActivity = Date.now();
      if (!canAcceptQRScan()) return;
      
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
          processQRCode(qrCode).catch(err => {
            log(`QR async error: ${err.message}`, 'error');
            clearQRProcessing();
          });
        } else {
          state.qrBuffer = '';
        }
        return;
      }
      
      if (e.name.length === 1) {
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
        
        state.qrBuffer += e.name;
        state.lastCharTime = currentTime;
        
        if (state.qrTimer) clearTimeout(state.qrTimer);
        state.qrTimer = setTimeout(() => {
          if (state.qrBuffer.length >= CONFIG.qr.minLength && 
              state.qrBuffer.length <= CONFIG.qr.maxLength &&
              !isConsoleOutput(state.qrBuffer)) {
            const qrCode = state.qrBuffer;
            state.qrBuffer = '';
            processQRCode(qrCode).catch(err => {
              log(`QR async error: ${err.message}`, 'error');
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
    log('QR scanner ready', 'success');
  } catch (error) {
    log(`QR scanner error: ${error.message}`, 'error');
    state.globalKeyListener = null;
  }
};

const setupQRScanner = () => {
  if (!CONFIG.qr.enabled) return;
  if (state.globalKeyListener) {
    try {
      state.globalKeyListener.kill();
      state.globalKeyListener = null;
    } catch (e) {}
    setTimeout(createKeyboardListener, 800);
    return;
  }
  createKeyboardListener();
};

// ============================================
// COMPACTOR
// ============================================
const startContinuousCompactor = async () => {
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
    resetCompactorIdleTimer();
  } catch (error) {
    log(`Compactor start failed: ${error.message}`, 'error');
    state.compactorRunning = false;
    throw error;
  }
};

const resetCompactorIdleTimer = () => {
  if (state.compactorIdleTimer) clearTimeout(state.compactorIdleTimer);
  state.lastItemTime = Date.now();
  state.compactorIdleTimer = setTimeout(async () => {
    if (state.compactorRunning && state.autoCycleEnabled) {
      await stopCompactor();
    }
  }, CONFIG.timing.compactorIdleStop);
};

const stopCompactor = async () => {
  if (!state.compactorRunning) return;
  try {
    await executeCommand('customMotor', CONFIG.motors.compactor.stop);
  } catch (error) {
    log(`Compactor stop error: ${error.message}`, 'error');
  }
  state.compactorRunning = false;
  if (state.compactorIdleTimer) {
    clearTimeout(state.compactorIdleTimer);
    state.compactorIdleTimer = null;
  }
};

// ============================================
// HEARTBEAT
// ============================================
const heartbeat = {
  interval: null,
  stateCheckInterval: null,
  timeout: CONFIG.heartbeat.interval,
  moduleIdRetries: 0,
  maxModuleIdRetries: CONFIG.heartbeat.maxModuleIdRetries,
  
  start() {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this.beat(), this.timeout * 1000);
    if (this.stateCheckInterval) clearInterval(this.stateCheckInterval);
    this.stateCheckInterval = setInterval(() => {
      if (state.processingQR && !state.processingQRTimeout) {
        clearQRProcessing();
      }
      if (!state.globalKeyListener && state.isReady && !state.autoCycleEnabled) {
        setupQRScanner();
      }
    }, CONFIG.heartbeat.stateCheckInterval * 1000);
    startScannerHealthMonitor();
  },
  
  stop() {
    if (this.interval) clearInterval(this.interval);
    if (this.stateCheckInterval) clearInterval(this.stateCheckInterval);
    if (state.scannerHealthTimer) clearInterval(state.scannerHealthTimer);
    this.interval = null;
    this.stateCheckInterval = null;
    state.scannerHealthTimer = null;
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
          log(`System ready - Module: ${state.moduleId}`, 'success');
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
      timestamp
    }));
  }
};

// ============================================
// MODULE ID
// ============================================
const requestModuleId = async () => {
  try {
    await axios.post(`${CONFIG.local.baseUrl}/system/serial/getModuleId`, {}, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    log(`Module ID request failed: ${error.message}`, 'error');
  }
};

// ============================================
// MATERIAL DETECTION
// ============================================
const determineMaterialType = (aiData) => {
  const className = (aiData.className || '').trim();
  const classNameLower = className.toLowerCase();
  const probability = aiData.probability || 0;
  
  let materialType = 'UNKNOWN';
  let threshold = 1.0;
  let isNewFormat = false;
  
  // New AI format: "0-PET" or "1-Can"
  if (className === '0-PET' || classNameLower === '0-pet') {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
    isNewFormat = true;
  } else if (className === '1-Can' || classNameLower === '1-can') {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
    isNewFormat = true;
  } 
  // Legacy format support
  else if (classNameLower.includes('易拉罐') || classNameLower.includes('metal') || 
           classNameLower.includes('can') || classNameLower.includes('铝')) {
    materialType = 'METAL_CAN';
    threshold = CONFIG.detection.METAL_CAN;
  } else if (classNameLower.includes('pet') || classNameLower.includes('plastic') || 
             classNameLower.includes('瓶') || classNameLower.includes('bottle')) {
    materialType = 'PLASTIC_BOTTLE';
    threshold = CONFIG.detection.PLASTIC_BOTTLE;
  }
  
  if (probability < CONFIG.detection.minConfidenceRetry && materialType === 'UNKNOWN') {
    return 'UNKNOWN';
  }
  
  if (materialType !== 'UNKNOWN' && probability < threshold) {
    const relaxedThreshold = isNewFormat ? threshold * 0.5 : threshold * 0.7;
    if (probability >= relaxedThreshold) return materialType;
    return 'UNKNOWN';
  }
  
  return materialType;
};

// ============================================
// HARDWARE CONTROL
// ============================================
const executeCommand = async (action, params = {}) => {
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
};

// ============================================
// REJECTION CYCLE
// ============================================
const executeRejectionCycle = async () => {
  try {
    await executeCommand('customMotor', CONFIG.motors.belt.reverse);
    await delay(CONFIG.timing.beltReverse);
    await executeCommand('customMotor', CONFIG.motors.belt.stop);
    
    state.stats.totalAttempts++;
    state.stats.failures++;
    
    mqttClient.publish(CONFIG.mqtt.topics.itemRejected, JSON.stringify({
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
    if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
};

// ============================================
// AUTO CYCLE
// ============================================
const executeAutoCycle = async () => {
  if (!state.aiResult || !state.weight || state.weight.weight <= 1) {
    state.cycleInProgress = false;
    return;
  }
  
  state.itemsProcessed++;
  
  state.stats.totalAttempts++;
  if (state.detectionRetries === 0) state.stats.firstSuccess++;
  else if (state.detectionRetries === 1) state.stats.secondSuccess++;
  else if (state.detectionRetries === 2) state.stats.thirdSuccess++;
  
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
    if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled && !state.cycleInProgress && !state.awaitingDetection) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
  }
};

// ============================================
// SESSION MANAGEMENT
// ============================================
const startMemberSession = async (validationData) => {
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
      user: { name: validationData.user.name, currentPoints: validationData.user.currentPoints },
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
    
    if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
    
    log(`Member session started: ${validationData.user.name}`, 'success');
  } catch (error) {
    log(`Session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true);
    throw error;
  }
};

const startGuestSession = async (sessionData) => {
  try {
    state.isReady = false;
    state.currentUserId = null;
    state.sessionId = sessionData.sessionId;
    state.sessionCode = sessionData.sessionCode;
    state.currentUserData = null;
    state.isMember = false;
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
    
    if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
    state.autoPhotoTimer = setTimeout(() => {
      if (state.autoCycleEnabled) {
        state.awaitingDetection = true;
        executeCommand('takePhoto');
      }
    }, CONFIG.timing.autoPhotoDelay);
    
    log('Guest session started', 'success');
  } catch (error) {
    log(`Session start error: ${error.message}`, 'error');
    await resetSystemForNextUser(true);
    throw error;
  }
};

const resetSystemForNextUser = async (forceStop = false) => {
  if (state.resetting) return;
  state.resetting = true;
  
  try {
    try {
      await executeCommand('closeGate');
    } catch (error) {
      log(`Gate close error: ${error.message}`, 'error');
    }
    
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
    } else if (state.compactorRunning) {
      await delay(2000);
      await stopCompactor();
    }
    
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
    state.lastItemTime = null;
    clearSessionTimers();
    clearQRProcessing();
    state.resetting = false;
    state.isReady = true;
    
    if (CONFIG.qr.restartAfterSession) {
      setTimeout(forceRestartScanner, 1500);
    }
    
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
    
    log('System reset complete', 'success');
  }
};

// ============================================
// SESSION TIMERS
// ============================================
const handleSessionTimeout = async (reason) => {
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
};

const resetInactivityTimer = () => {
  if (state.sessionTimeoutTimer) clearTimeout(state.sessionTimeoutTimer);
  state.sessionTimeoutTimer = setTimeout(() => {
    handleSessionTimeout('inactivity');
  }, CONFIG.timing.sessionTimeout);
};

const startSessionTimers = () => {
  resetInactivityTimer();
  if (state.maxDurationTimer) clearTimeout(state.maxDurationTimer);
  state.maxDurationTimer = setTimeout(() => {
    handleSessionTimeout('max_duration');
  }, CONFIG.timing.sessionMaxDuration);
};

const clearSessionTimers = () => {
  if (state.sessionTimeoutTimer) {
    clearTimeout(state.sessionTimeoutTimer);
    state.sessionTimeoutTimer = null;
  }
  if (state.maxDurationTimer) {
    clearTimeout(state.maxDurationTimer);
    state.maxDurationTimer = null;
  }
};

// ============================================
// WEBSOCKET
// ============================================
const connectWebSocket = () => {
  if (state.ws) {
    try {
      state.ws.removeAllListeners();
      state.ws.close();
    } catch (e) {}
    state.ws = null;
  }
  
  state.ws = new WebSocket(CONFIG.local.wsUrl);
  
  state.ws.on('open', () => {
    if (!state.moduleId) setTimeout(requestModuleId, 1000);
  });
  
  state.ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.function === '01') {
        state.moduleId = message.moduleId;
        heartbeat.moduleIdRetries = 0;
        if (!state.isReady) {
          state.isReady = true;
          log(`System ready - Module: ${state.moduleId}`, 'success');
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
                if (state.autoCycleEnabled) executeCommand('takePhoto');
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
          0: { name: 'Plastic', key: 'plastic', critical: true },
          1: { name: 'Metal', key: 'metal', critical: true },
          2: { name: 'Right', key: 'right', critical: false },
          3: { name: 'Glass', key: 'glass', critical: false },
          4: { name: 'Sensor', key: null, critical: false }
        };
        
        const binInfo = binStatusMap[binCode];
        if (binInfo) {
          if (binInfo.key) state.binStatus[binInfo.key] = true;
          
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
          
          if (binInfo.critical && state.autoCycleEnabled) {
            const currentMaterialBin = state.aiResult?.materialType === 'METAL_CAN' ? 'metal' : 'plastic';
            if (binInfo.key === currentMaterialBin) {
              log(`Bin full: ${binInfo.name}`, 'warning');
              setTimeout(() => handleSessionTimeout('bin_full'), 2000);
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
            if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
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
    setTimeout(connectWebSocket, 5000);
  });
};

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
  log('MQTT connected', 'success');
  mqttClient.subscribe(CONFIG.mqtt.topics.commands);
  mqttClient.subscribe(CONFIG.mqtt.topics.qrInput);
  mqttClient.subscribe(CONFIG.mqtt.topics.guestStart);
  
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'online',
    event: 'device_connected',
    timestamp: new Date().toISOString()
  }), { retain: true });
  
  connectWebSocket();
  setTimeout(requestModuleId, 2000);
  setTimeout(() => heartbeat.start(), 5000);
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
    
    if (topic === CONFIG.mqtt.topics.commands) {
      if (payload.action === 'getStatus') {
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
          stats: state.stats,
          timestamp: new Date().toISOString()
        }));
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
      
      if (payload.action === 'restartScanner') {
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
        state.binStatus = { plastic: false, metal: false, right: false, glass: false };
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
        processQRCode(qrCode).catch(err => log(`QR error: ${err.message}`, 'error'));
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
const gracefulShutdown = () => {
  clearQRProcessing();
  heartbeat.stop();
  stopCompactor();
  if (state.autoPhotoTimer) clearTimeout(state.autoPhotoTimer);
  clearSessionTimers();
  if (state.globalKeyListener) {
    try { state.globalKeyListener.kill(); } catch (e) {}
  }
  mqttClient.publish(CONFIG.mqtt.topics.status, JSON.stringify({
    deviceId: CONFIG.device.id,
    status: 'offline',
    timestamp: new Date().toISOString()
  }), { retain: true });
  if (state.ws) {
    try { state.ws.close(); } catch (e) {}
  }
  setTimeout(() => {
    mqttClient.end();
    process.exit(0);
  }, 1000);
};

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
log(`RVM Agent Production - Device: ${CONFIG.device.id}`, 'info');
log('System starting...', 'info');