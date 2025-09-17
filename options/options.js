import { credentialManager } from '../utils/crypto-utils.js';

// Get elements
const credentialsForm = document.getElementById('credentials-form');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const saveMessage = document.getElementById('save-message');
const pauseToggle = document.getElementById('pause-toggle');
const currentStatusEl = document.getElementById('current-status');
const lastLoginEl = document.getElementById('last-login');
const nextRenewalEl = document.getElementById('next-renewal');

// Status mapping
const statusText = {
  idle: 'Idle',
  checking: 'Checking...',
  connected: 'Connected',
  needs_login: 'Needs login',
  error: 'Error',
  network_down: 'Network down'
};

let refreshInterval = null;
let isInitialized = false;

// Initialize the page
async function initialize() {
  if (isInitialized) return;
  
  try {
    console.log('Initializing options page');
    
    // Test encryption system
    const encryptionWorks = await credentialManager.testEncryption();
    if (!encryptionWorks) {
      showMessage('Warning: Encryption system may not be working properly', 'error');
    }
    
    await loadSettings();
    await loadStatus();
    
    // Start refresh interval
    refreshInterval = setInterval(loadStatus, 10000); // Refresh every 10 seconds
    
    isInitialized = true;
    console.log('Options page initialized successfully');
    
  } catch (error) {
    console.error('Initialization error:', error);
    showMessage('Failed to initialize page: ' + error.message, 'error');
  }
}

// Format timestamp
function formatTimestamp(timestamp) {
  if (!timestamp) return '-';
  try {
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '-';
    return date.toLocaleString();
  } catch {
    return '-';
  }
}

// Format future time
function formatFutureTime(timestamp) {
  if (!timestamp) return '-';
  
  try {
    const date = new Date(timestamp);
    const now = new Date();
    
    if (isNaN(date.getTime())) return '-';
    if (date < now) return 'Expired';
    
    const diff = date - now;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    
    if (hours > 0) {
      return `${date.toLocaleString()} (in ${hours}h ${mins}m)`;
    } else {
      return `${date.toLocaleString()} (in ${mins}m)`;
    }
  } catch {
    return '-';
  }
}

// Show message with auto-hide
function showMessage(text, type) {
  if (!saveMessage) return;
  
  saveMessage.textContent = text;
  saveMessage.className = `message ${type}`;
  saveMessage.style.display = 'block';
  
  // Auto-hide after 5 seconds for success, longer for errors
  const hideDelay = type === 'success' ? 5000 : 8000;
  setTimeout(() => {
    if (saveMessage) {
      saveMessage.style.display = 'none';
    }
  }, hideDelay);
}

// Load saved settings
async function loadSettings() {
  try {
    console.log('Loading settings');
    const data = await chrome.storage.local.get(['encryptedCreds', 'paused']);

    if (data.encryptedCreds) {
      if (usernameInput) {
        usernameInput.placeholder = "Username saved (encrypted)";
      }
      if (passwordInput) {
        passwordInput.placeholder = "Password saved (encrypted)";
      }
      console.log('Found encrypted credentials');
    } else {
      console.log('No encrypted credentials found');
    }
    
    if (pauseToggle) {
      pauseToggle.checked = data.paused || false;
    }
    
  } catch (error) {
    console.error('Error loading settings:', error);
    showMessage('Error loading settings: ' + error.message, 'error');
  }
}

// Load status from background script
async function loadStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-state' });
    
    if (response) {
      updateStatusDisplay(response);
    } else {
      console.warn('No response from background script');
      if (currentStatusEl) {
        currentStatusEl.textContent = 'Extension not responding';
        currentStatusEl.style.color = 'var(--md-sys-color-error)';
      }
    }
    
  } catch (error) {
    console.error('Error loading status:', error);
    if (currentStatusEl) {
      currentStatusEl.textContent = 'Error loading status';
      currentStatusEl.style.color = 'var(--md-sys-color-error)';
    }
  }
}

// Update status display
function updateStatusDisplay(state) {
  if (currentStatusEl) {
    currentStatusEl.textContent = statusText[state.status] || 'Unknown';
    
    // Update status color
    if (state.status === 'connected') {
      currentStatusEl.style.color = 'var(--md-sys-color-success)';
    } else if (state.status === 'error' || state.status === 'network_down') {
      currentStatusEl.style.color = 'var(--md-sys-color-error)';
    } else if (state.status === 'checking') {
      currentStatusEl.style.color = 'var(--md-sys-color-primary)';
    } else {
      currentStatusEl.style.color = '';
    }
  }
  
  if (lastLoginEl) {
    lastLoginEl.textContent = formatTimestamp(state.lastLoginAt);
  }
  
  if (nextRenewalEl) {
    nextRenewalEl.textContent = formatFutureTime(state.nextRenewAt);
  }
  
  // Show last error if present
  if (state.lastError && state.status === 'error') {
    showMessage('Status: ' + state.lastError, 'error');
  }
}

// Validate credentials before saving
function validateCredentials(username, password) {
  if (!username || username.trim().length === 0) {
    throw new Error('Username is required');
  }
  
  if (!password || password.length === 0) {
    throw new Error('Password is required');
  }
  
  if (username.trim().length < 3) {
    throw new Error('Username must be at least 3 characters');
  }
  
  if (password.length < 4) {
    throw new Error('Password must be at least 4 characters');
  }
  
  // Check for common issues
  if (username.includes(' ') && !confirm('Username contains spaces. Is this correct?')) {
    throw new Error('Username validation cancelled');
  }
  
  return {
    username: username.trim(),
    password: password
  };
}

// Save credentials with enhanced error handling
async function saveCredentials(username, password) {
  try {
    console.log('Starting credential save process');
    
    // Validate inputs
    const validatedCreds = validateCredentials(username, password);
    
    // Show saving status
    showMessage('Encrypting and saving credentials...', 'info');
    
    // Encrypt credentials
    const encrypted = await credentialManager.encryptCredentials(
      validatedCreds.username, 
      validatedCreds.password
    );
    
    // Save to storage
    await chrome.storage.local.set({ encryptedCreds: encrypted });
    
    console.log('Credentials saved successfully');
    
    // Clear form for security
    if (usernameInput) {
      usernameInput.value = '';
      usernameInput.placeholder = "Username saved (encrypted)";
    }
    if (passwordInput) {
      passwordInput.value = '';
      passwordInput.placeholder = "Password saved (encrypted)";
    }
    
    showMessage('Credentials encrypted and saved successfully!', 'success');
    
    // Trigger a login attempt
    setTimeout(async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'force-login' });
        if (response && !response.success && response.message) {
          showMessage('Login attempt: ' + response.message, 'info');
        }
      } catch (error) {
        console.error('Failed to trigger login:', error);
      }
    }, 1000);
    
  } catch (error) {
    console.error('Error saving credentials:', error);
    let errorMessage = 'Error saving credentials';
    
    if (error.message.includes('encrypt')) {
      errorMessage = 'Encryption failed - please try again';
    } else if (error.message.includes('storage')) {
      errorMessage = 'Storage error - please check browser settings';
    } else {
      errorMessage = error.message;
    }
    
    showMessage(errorMessage, 'error');
  }
}

// Handle form submission
if (credentialsForm) {
  credentialsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!usernameInput || !passwordInput) {
      showMessage('Form elements not found', 'error');
      return;
    }
    
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    
    if (!username || !password) {
      showMessage('Please enter both username and password', 'error');
      usernameInput.focus();
      return;
    }
    
    // Disable form during save
    const submitButton = credentialsForm.querySelector('button[type="submit"]');
    const originalText = submitButton ? submitButton.textContent : '';
    
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = 'Saving...';
    }
    
    try {
      await saveCredentials(username, password);
    } finally {
      // Re-enable form
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalText;
      }
    }
  });
}

// Handle pause toggle
if (pauseToggle) {
  pauseToggle.addEventListener('change', async () => {
    try {
      const paused = pauseToggle.checked;
      await chrome.runtime.sendMessage({ 
        type: 'toggle-pause', 
        paused: paused
      });
      
      console.log(`Auto-login ${paused ? 'paused' : 'resumed'}`);
      showMessage(`Auto-login ${paused ? 'paused' : 'resumed'}`, 'success');
      
    } catch (error) {
      console.error('Toggle pause error:', error);
      showMessage('Failed to toggle pause state', 'error');
      
      // Revert toggle state on error
      pauseToggle.checked = !pauseToggle.checked;
    }
  });
}

// Listen for state updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'state-update') {
    console.log('Received state update:', message.state.status);
    updateStatusDisplay(message.state);
  }
});

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Page is hidden, reduce refresh frequency
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = setInterval(loadStatus, 30000); // 30 seconds
    }
  } else {
    // Page is visible, increase refresh frequency
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = setInterval(loadStatus, 10000); // 10 seconds
    }
    // Immediate refresh when page becomes visible
    loadStatus();
  }
});

// Clean up on unload
window.addEventListener('unload', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});

// Add keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Ctrl+S or Cmd+S to save credentials
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (credentialsForm) {
      credentialsForm.dispatchEvent(new Event('submit'));
    }
  }
  
  // F5 to refresh status
  if (e.key === 'F5') {
    e.preventDefault();
    loadStatus();
  }
});

// Add some helpful methods for debugging (available in console)
window.debugExtension = {
  async testEncryption() {
    try {
      const result = await credentialManager.testEncryption();
      console.log('Encryption test result:', result);
      return result;
    } catch (error) {
      console.error('Encryption test error:', error);
      return false;
    }
  },
  
  async clearAllData() {
    if (confirm('This will clear all stored credentials and settings. Continue?')) {
      try {
        await credentialManager.clearStoredData();
        await chrome.storage.local.clear();
        console.log('All data cleared');
        location.reload();
      } catch (error) {
        console.error('Error clearing data:', error);
      }
    }
  },
  
  async getDebugLogs() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'get-debug-logs' });
      console.table(response.logs);
      return response.logs;
    } catch (error) {
      console.error('Error getting logs:', error);
      return [];
    }
  },
  
  async forceLogin() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'force-login' });
      console.log('Force login response:', response);
      return response;
    } catch (error) {
      console.error('Force login error:', error);
      return { error: error.message };
    }
  }
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}