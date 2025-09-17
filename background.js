import { credentialManager } from './utils/crypto-utils.js';

// State management
let state = {
  status: 'idle', // idle, checking, connected, needs_login, error, network_down
  lastError: null,
  lastLoginAt: null,
  nextRenewAt: null,
  isConnected: false,
  retryCount: 0,
  sessionTimeout: 1200 // Default 20 minutes, will be updated dynamically
};

// Constants
const PORTAL_URL = 'https://agnigarh.iitg.ac.in:1442/login?';
const PORTAL_BASE = 'https://agnigarh.iitg.ac.in:1442';
const RENEW_BEFORE = 120; // Renew 2 minutes before expiry
const CHECK_INTERVAL = 1; // Check every 1 minute
const RETRY_DELAYS = [5, 15, 45, 120]; // Exponential backoff in seconds
const REQUEST_TIMEOUT = 10000; // 10 seconds

// Logging utility
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  
  console.log(logEntry, data || '');
  
  // Store recent logs for debugging
  chrome.storage.local.get('debugLogs').then(({ debugLogs = [] }) => {
    debugLogs.push({ timestamp, level, message, data });
    
    // Keep only last 100 logs
    if (debugLogs.length > 100) {
      debugLogs = debugLogs.slice(-100);
    }
    
    chrome.storage.local.set({ debugLogs });
  }).catch(() => {}); // Ignore storage errors
}

// Initialize
chrome.runtime.onInstalled.addListener(() => {
  log('info', 'Extension installed/updated');
  setupAlarms();
  loadState();
});

chrome.runtime.onStartup.addListener(() => {
  log('info', 'Extension started');
  setupAlarms();
  loadState();
});

// Setup periodic checks
function setupAlarms() {
  chrome.alarms.clear('connectivity-check').then(() => {
    chrome.alarms.create('connectivity-check', { periodInMinutes: CHECK_INTERVAL });
    log('info', 'Connectivity check alarm created');
  });
  
  chrome.alarms.onAlarm.addListener(handleAlarm);
}

async function handleAlarm(alarm) {
  if (alarm.name === 'connectivity-check') {
    try {
      const { paused } = await chrome.storage.local.get('paused');
      if (!paused) {
        log('debug', 'Periodic connectivity check triggered');
        await checkAndLogin();
      } else {
        log('debug', 'Auto-login paused, skipping check');
      }
    } catch (error) {
      log('error', 'Alarm handler error', error.message);
    }
  }
}

// Load persisted state
async function loadState() {
  try {
    const data = await chrome.storage.local.get(['lastLoginAt', 'nextRenewAt', 'paused', 'sessionTimeout']);
    if (data.lastLoginAt) state.lastLoginAt = data.lastLoginAt;
    if (data.nextRenewAt) state.nextRenewAt = data.nextRenewAt;
    if (data.sessionTimeout) state.sessionTimeout = data.sessionTimeout;
    
    log('info', 'State loaded', { 
      lastLogin: data.lastLoginAt ? new Date(data.lastLoginAt).toISOString() : null,
      paused: data.paused 
    });
    
    // Initial check
    if (!data.paused) {
      setTimeout(() => checkAndLogin(), 2000); // Delay initial check
    }
  } catch (error) {
    log('error', 'Failed to load state', error.message);
  }
}

// Update state and persist
function updateState(updates) {
  const oldStatus = state.status;
  state = { ...state, ...updates };
  
  log('debug', 'State updated', { 
    from: oldStatus, 
    to: state.status, 
    error: state.lastError,
    retryCount: state.retryCount
  });
  
  // Update icon based on status
  let iconPath = 'icons/icon-default-48.png';
  let badgeText = '';
  
  switch (state.status) {
    case 'connected':
      iconPath = 'icons/icon-green-48.png';
      badgeText = 'OK';
      break;
    case 'error':
    case 'network_down':
      iconPath = 'icons/icon-red-48.png';
      badgeText = 'ERR';
      break;
    case 'checking':
      badgeText = '...';
      break;
    default:
      badgeText = '—';
  }
  
  chrome.action.setIcon({ path: iconPath }).catch(() => {});
  chrome.action.setBadgeText({ text: badgeText }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#666666' }).catch(() => {});
  
  // Persist important state
  if (updates.lastLoginAt !== undefined || updates.nextRenewAt !== undefined || updates.sessionTimeout !== undefined) {
    chrome.storage.local.set({
      lastLoginAt: state.lastLoginAt,
      nextRenewAt: state.nextRenewAt,
      sessionTimeout: state.sessionTimeout
    }).catch((error) => {
      log('error', 'Failed to persist state', error.message);
    });
  }
  
  // Broadcast state change
  chrome.runtime.sendMessage({ type: 'state-update', state }).catch(() => {});
}

// Enhanced connectivity check
async function checkConnectivity() {
  log('debug', 'Checking connectivity');
  
  try {
    // Test 1: Try to reach Google's connectivity check endpoint
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    
    try {
      const response = await fetch('https://connectivitycheck.gstatic.com/generate_204', {
        method: 'GET',
        cache: 'no-cache',
        redirect: 'manual',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.status === 204) {
        log('debug', 'Internet connectivity confirmed');
        return { connected: true };
      }
      
      log('debug', 'Connectivity check got unexpected response', response.status);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        log('debug', 'Connectivity check timed out');
      } else {
        log('debug', 'Connectivity check failed', fetchError.message);
      }
    }
    
    // Test 2: Try to reach the portal directly
    const portalController = new AbortController();
    const portalTimeoutId = setTimeout(() => portalController.abort(), REQUEST_TIMEOUT);
    
    try {
      const portalResponse = await fetch(PORTAL_URL, {
        method: 'HEAD',
        cache: 'no-cache',
        credentials: 'include',
        signal: portalController.signal
      });
      
      clearTimeout(portalTimeoutId);
      
      if (portalResponse.ok || portalResponse.status === 302) {
        log('debug', 'Portal reachable, needs login');
        return { connected: false, needsLogin: true };
      }
    } catch (portalError) {
      clearTimeout(portalTimeoutId);
      log('debug', 'Portal check failed', portalError.message);
    }
    
    // If we can't reach either, assume network is down
    return { connected: false, networkDown: true };
    
  } catch (error) {
    log('error', 'Connectivity check error', error.message);
    return { connected: false, networkDown: true };
  }
}

// Main check and login flow
async function checkAndLogin(forceLogin = false) {
  updateState({ status: 'checking' });
  
  // Check if we need to renew
  const now = Date.now();
  const shouldRenew = state.nextRenewAt && now >= state.nextRenewAt;
  
  if (forceLogin) {
    log('info', 'Force login requested');
  } else if (shouldRenew) {
    log('info', 'Session renewal required');
  }
  
  if (!forceLogin && !shouldRenew) {
    // Regular connectivity check
    const connectivity = await checkConnectivity();
    
    if (connectivity.connected) {
      updateState({ 
        status: 'connected',
        isConnected: true,
        lastError: null,
        retryCount: 0
      });
      return;
    } else if (connectivity.networkDown) {
      await handleNetworkDown();
      return;
    }
  }
  
  // Need to login
  await performLogin();
}

// Handle network down
async function handleNetworkDown() {
  if (state.retryCount < RETRY_DELAYS.length) {
    const delay = RETRY_DELAYS[state.retryCount];
    updateState({ 
      status: 'network_down',
      lastError: 'Network unreachable',
      retryCount: state.retryCount + 1
    });
    
    log('warn', `Network down, retrying in ${delay}s (attempt ${state.retryCount})`);
    setTimeout(() => checkAndLogin(), delay * 1000);
  } else {
    updateState({ 
      status: 'network_down',
      lastError: 'Network unreachable - max retries exceeded',
      retryCount: 0
    });
    log('error', 'Max retries exceeded for network connectivity');
  }
}

// Enhanced form parsing
function extractFormData(html) {
  const formData = {};
  
  // Multiple regex patterns for different HTML formatting styles
  const patterns = {
    magic: [
      /name="magic"\s+value="([^"]+)"/i,
      /name='magic'\s+value='([^']+)'/i,
      /<input[^>]*name="magic"[^>]*value="([^"]+)"/i,
      /value="([^"]+)"[^>]*name="magic"/i
    ],
    tredir: [
      /name="4Tredir"\s+value="([^"]+)"/i,
      /name='4Tredir'\s+value='([^']+)'/i,
      /<input[^>]*name="4Tredir"[^>]*value="([^"]+)"/i,
      /value="([^"]+)"[^>]*name="4Tredir"/i
    ]
  };
  
  for (const [field, regexes] of Object.entries(patterns)) {
    for (const regex of regexes) {
      const match = html.match(regex);
      if (match) {
        formData[field] = match[1];
        log('debug', `Extracted ${field} from form`);
        break;
      }
    }
  }
  
  // Set default redirect URL if not found
  if (!formData.tredir) {
    formData.tredir = PORTAL_URL;
  }
  
  return formData;
}

// Detect session timeout from portal response
function detectSessionTimeout(html) {
  const patterns = [
    /session[_\s]*timeout[_\s]*[:\=]\s*(\d+)/i,
    /keepalive[_\s]*[:\=]\s*(\d+)/i,
    /timeout[_\s]*[:\=]\s*(\d+)[_\s]*min/i
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      let timeout = parseInt(match[1]);
      // Convert minutes to seconds if needed
      if (timeout < 60) timeout *= 60;
      log('info', `Detected session timeout: ${timeout}s`);
      return timeout;
    }
  }
  
  return state.sessionTimeout; // Use current value if not detected
}

// Enhanced login performance
async function performLogin() {
  const startTime = Date.now();
  log('info', 'Starting login process');
  
  try {
    const { encryptedCreds } = await chrome.storage.local.get('encryptedCreds');
    
    if (!encryptedCreds) {
      updateState({ 
        status: 'error',
        lastError: 'Credentials not configured',
        isConnected: false
      });
      showCredentialsNotification();
      return;
    }
    
    const credentials = await credentialManager.decryptCredentials(encryptedCreds);
    
    if (!credentials || !credentials.username || !credentials.password) {
      updateState({ 
        status: 'error',
        lastError: 'Failed to decrypt credentials',
        isConnected: false
      });
      showCredentialsNotification();
      return;
    }
    
    const { username, password } = credentials;
    log('info', 'Credentials decrypted successfully');
    
    // Step 1: Get login page with timeout
    const controller1 = new AbortController();
    const timeout1 = setTimeout(() => controller1.abort(), REQUEST_TIMEOUT);
    
    const loginPageResponse = await fetch(PORTAL_URL, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller1.signal
    });
    
    clearTimeout(timeout1);
    
    if (!loginPageResponse.ok) {
      throw new Error(`Failed to fetch login page: ${loginPageResponse.status}`);
    }
    
    const loginPageHtml = await loginPageResponse.text();
    log('debug', 'Login page fetched successfully');
    
    // Extract form data
    const formData = extractFormData(loginPageHtml);
    
    if (!formData.magic) {
      throw new Error('Could not find magic token in login page');
    }
    
    // Detect session timeout
    const detectedTimeout = detectSessionTimeout(loginPageHtml);
    if (detectedTimeout !== state.sessionTimeout) {
      updateState({ sessionTimeout: detectedTimeout });
    }
    
    // Step 2: Submit login form
    const loginForm = new URLSearchParams();
    loginForm.append('username', username);
    loginForm.append('password', password);
    loginForm.append('magic', formData.magic);
    loginForm.append('4Tredir', formData.tredir);
    
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), REQUEST_TIMEOUT);
    
    const loginResponse = await fetch(`${PORTAL_BASE}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Origin': PORTAL_BASE,
        'Referer': PORTAL_URL,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: loginForm.toString(),
      credentials: 'include',
      redirect: 'manual',
      signal: controller2.signal
    });
    
    clearTimeout(timeout2);
    
    // Check if login was successful
    let isSuccess = false;
    let responseText = '';
    
    // Check for redirect (successful login usually redirects)
    if (loginResponse.status === 302 || loginResponse.status === 303) {
      isSuccess = true;
      log('info', 'Login successful (redirect detected)');
    } else if (loginResponse.ok) {
      responseText = await loginResponse.text();
      
      // Look for success indicators
      const successIndicators = ['keepalive', 'logout', 'success', 'welcome'];
      const errorIndicators = ['invalid', 'failed', 'incorrect', 'error', 'login-form'];
      
      const hasSuccess = successIndicators.some(indicator => 
        responseText.toLowerCase().includes(indicator)
      );
      const hasError = errorIndicators.some(indicator => 
        responseText.toLowerCase().includes(indicator)
      );
      
      if (hasSuccess && !hasError) {
        isSuccess = true;
        log('info', 'Login successful (success indicators found)');
      } else if (hasError) {
        log('warn', 'Login failed (error indicators found)');
        updateState({
          status: 'error',
          lastError: 'Invalid credentials',
          isConnected: false,
          retryCount: 0
        });
        showCredentialsNotification();
        return;
      }
    }
    
    if (isSuccess) {
      const now = Date.now();
      const sessionDuration = (state.sessionTimeout - RENEW_BEFORE) * 1000;
      const nextRenew = now + sessionDuration;
      
      updateState({
        status: 'connected',
        isConnected: true,
        lastError: null,
        lastLoginAt: now,
        nextRenewAt: nextRenew,
        retryCount: 0
      });
      
      const loginTime = Date.now() - startTime;
      log('info', `Login completed successfully in ${loginTime}ms`);
    } else {
      throw new Error('Login failed - unexpected response');
    }
    
  } catch (error) {
    const loginTime = Date.now() - startTime;
    log('error', `Login failed after ${loginTime}ms: ${error.message}`);
    
    if (error.name === 'AbortError') {
      updateState({
        status: 'error',
        lastError: 'Login request timed out'
      });
    } else if (state.retryCount < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[state.retryCount];
      updateState({
        status: 'error',
        lastError: error.message,
        retryCount: state.retryCount + 1
      });
      
      log('warn', `Retrying login in ${delay}s (attempt ${state.retryCount + 1})`);
      setTimeout(() => performLogin(), delay * 1000);
    } else {
      updateState({
        status: 'error',
        lastError: 'Login failed - ' + error.message,
        isConnected: false,
        retryCount: 0
      });
    }
  }
}

// Show notification for invalid credentials
function showCredentialsNotification() {
  chrome.notifications.create('credentials-needed', {
    type: 'basic',
    iconUrl: 'icons/icon-red-48.png',
    title: 'IITG Wi-Fi Auto Login',
    message: 'Please check your credentials in the extension options.',
    buttons: [{ title: 'Open Options' }],
    requireInteraction: true
  }).catch(() => {}); // Ignore notification errors
}

// Handle notification clicks
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId === 'credentials-needed' && buttonIndex === 0) {
    chrome.runtime.openOptionsPage();
  }
  chrome.notifications.clear(notificationId);
});

// Message handling
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.type) {
    case 'get-state':
      sendResponse(state);
      break;
      
    case 'force-login':
      if (state.status === 'connected') {
        sendResponse({ success: false, message: 'Already connected' });
      } else if (state.status === 'checking') {
        sendResponse({ success: false, message: 'Already checking...' });
      } else {
        log('info', 'Force login requested from UI');
        checkAndLogin(true).then(() => {
          sendResponse({ success: true });
        }).catch((error) => {
          sendResponse({ success: false, message: error.message });
        });
      }
      return true; // Will respond asynchronously
      
    case 'toggle-pause':
      chrome.storage.local.set({ paused: request.paused }).then(() => {
        log('info', `Auto-login ${request.paused ? 'paused' : 'resumed'}`);
        if (!request.paused) {
          checkAndLogin();
        }
        sendResponse({ success: true });
      }).catch((error) => {
        sendResponse({ success: false, message: error.message });
      });
      return true; // Will respond asynchronously
      
    case 'get-debug-logs':
      chrome.storage.local.get('debugLogs').then(({ debugLogs = [] }) => {
        sendResponse({ logs: debugLogs });
      }).catch(() => {
        sendResponse({ logs: [] });
      });
      return true;
      
    case 'clear-debug-logs':
      chrome.storage.local.remove('debugLogs').then(() => {
        sendResponse({ success: true });
      }).catch(() => {
        sendResponse({ success: false });
      });
      return true;
      
    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// Listen for storage changes from options page
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.encryptedCreds) {
      // Credentials updated, clear error state if any
      if (state.lastError === 'Credentials not configured' || 
          state.lastError === 'Failed to decrypt credentials' ||
          state.lastError === 'Invalid credentials') {
        log('info', 'Credentials updated, attempting login');
        updateState({ lastError: null, status: 'idle', retryCount: 0 });
        setTimeout(() => checkAndLogin(), 1000);
      }
    }
  }
});

// Handle extension context invalidation
chrome.runtime.onSuspend.addListener(() => {
  log('info', 'Extension suspending');
});

// Network state monitoring (if available)
if (typeof navigator !== 'undefined' && 'connection' in navigator) {
  navigator.connection.addEventListener('change', () => {
    log('info', 'Network state changed', {
      effectiveType: navigator.connection.effectiveType,
      downlink: navigator.connection.downlink
    });
    
    // Recheck connectivity after network change
    setTimeout(() => {
      const { paused } = chrome.storage.local.get('paused').then(data => {
        if (!data.paused) {
          checkAndLogin();
        }
      });
    }, 3000);
  });
}