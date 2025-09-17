// Get elements
const statusChip = document.getElementById('status-chip');
const statusText = statusChip?.querySelector('.status-text');
const forceLoginBtn = document.getElementById('force-login');
const pauseToggle = document.getElementById('pause-toggle');
const lastLoginEl = document.getElementById('last-login');
const nextRenewalEl = document.getElementById('next-renewal');
const lastErrorEl = document.getElementById('last-error');
const optionsLink = document.getElementById('options-link');

// Status to UI mapping
const statusConfig = {
  idle: { text: 'Idle', className: '' },
  checking: { text: 'Checking...', className: '' },
  connected: { text: 'Connected', className: 'connected' },
  needs_login: { text: 'Needs login', className: '' },
  error: { text: 'Error', className: 'error' },
  network_down: { text: 'Network down', className: 'error' }
};

let refreshInterval = null;
let isInitialized = false;

// Initialize popup
async function initialize() {
  if (isInitialized) return;
  
  try {
    console.log('Initializing popup');
    
    await loadState();
    
    // Start refresh interval
    refreshInterval = setInterval(loadState, 5000); // Refresh every 5 seconds
    
    isInitialized = true;
    console.log('Popup initialized successfully');
    
  } catch (error) {
    console.error('Popup initialization error:', error);
    updateStatusDisplay({ 
      status: 'error', 
      lastError: 'Failed to initialize: ' + error.message 
    });
  }
}

// Format timestamp for display
function formatTime(timestamp) {
  if (!timestamp) return '-';
  
  try {
    const date = new Date(timestamp);
    const now = new Date();
    
    if (isNaN(date.getTime())) return '-';
    
    const diff = now - date;
    
    if (diff < 60000) {
      return 'Just now';
    } else if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes}m ago`;
    } else if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString();
    }
  } catch {
    return '-';
  }
}

// Format future time for display
function formatFutureTime(timestamp) {
  if (!timestamp) return '-';
  
  try {
    const date = new Date(timestamp);
    const now = new Date();
    
    if (isNaN(date.getTime())) return '-';
    if (date < now) return 'Now';
    
    const diff = date - now;
    if (diff < 60000) return 'Less than 1m';
    
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `In ${minutes}m`;
    
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `In ${hours}h ${mins}m`;
  } catch {
    return '-';
  }
}

// Update UI based on state
function updateUI(state) {
  updateStatusDisplay(state);
  updateDiagnostics(state);
  updateControls(state);
}

// Update status chip display
function updateStatusDisplay(state) {
  const config = statusConfig[state.status] || statusConfig.idle;
  
  if (statusText) {
    statusText.textContent = config.text;
  }
  
  if (statusChip) {
    statusChip.className = 'status-chip' + (config.className ? ' ' + config.className : '');
  }
}

// Update diagnostics section
function updateDiagnostics(state) {
  if (lastLoginEl) {
    lastLoginEl.textContent = formatTime(state.lastLoginAt);
  }
  
  if (nextRenewalEl) {
    nextRenewalEl.textContent = formatFutureTime(state.nextRenewAt);
  }
  
  if (lastErrorEl) {
    lastErrorEl.textContent = state.lastError || '-';
    
    // Truncate very long error messages
    if (state.lastError && state.lastError.length > 50) {
      lastErrorEl.textContent = state.lastError.substring(0, 47) + '...';
      lastErrorEl.title = state.lastError; // Show full error on hover
    } else {
      lastErrorEl.title = '';
    }
  }
}

// Update control states
function updateControls(state) {
  // Update force login button
  if (forceLoginBtn) {
    const isChecking = state.status === 'checking';
    forceLoginBtn.disabled = isChecking;
    
    // Update button text based on state
    if (isChecking) {
      forceLoginBtn.textContent = 'Checking...';
    } else if (state.status === 'connected') {
      forceLoginBtn.textContent = 'Force Reconnect';
    } else {
      forceLoginBtn.textContent = 'Login Now';
    }
  }
}

// Load initial state
async function loadState() {
  try {
    // Get pause state from storage
    const { paused } = await chrome.storage.local.get('paused');
    if (pauseToggle) {
      pauseToggle.checked = paused || false;
    }
    
    // Get current state from background
    const response = await chrome.runtime.sendMessage({ type: 'get-state' });
    
    if (response) {
      updateUI(response);
    } else {
      console.warn('No response from background script');
      updateStatusDisplay({ 
        status: 'error', 
        lastError: 'Extension not responding' 
      });
    }
    
  } catch (error) {
    console.error('Error loading state:', error);
    updateStatusDisplay({ 
      status: 'error', 
      lastError: 'Failed to load status' 
    });
  }
}

// Handle force login button
if (forceLoginBtn) {
  forceLoginBtn.addEventListener('click', async () => {
    const originalText = forceLoginBtn.textContent;
    forceLoginBtn.disabled = true;
    forceLoginBtn.textContent = 'Requesting...';
    
    try {
      console.log('Force login requested');
      const response = await chrome.runtime.sendMessage({ type: 'force-login' });
      
      if (response) {
        if (!response.success && response.message) {
          // Show temporary message
          forceLoginBtn.textContent = response.message;
          setTimeout(() => {
            if (forceLoginBtn) {
              forceLoginBtn.textContent = originalText;
            }
          }, 3000);
        } else if (response.success) {
          forceLoginBtn.textContent = 'Requested';
          setTimeout(() => {
            if (forceLoginBtn) {
              forceLoginBtn.textContent = originalText;
            }
          }, 2000);
        }
      }
      
    } catch (error) {
      console.error('Force login error:', error);
      forceLoginBtn.textContent = 'Error';
      setTimeout(() => {
        if (forceLoginBtn) {
          forceLoginBtn.textContent = originalText;
        }
      }, 3000);
    }
    
    // Re-enable button
    setTimeout(() => {
      if (forceLoginBtn) {
        forceLoginBtn.disabled = false;
        if (forceLoginBtn.textContent === 'Requesting...' || 
            forceLoginBtn.textContent === 'Requested' ||
            forceLoginBtn.textContent === 'Error') {
          forceLoginBtn.textContent = originalText;
        }
      }
    }, 5000);
  });
}

// Handle pause toggle
if (pauseToggle) {
  pauseToggle.addEventListener('change', async () => {
    const paused = pauseToggle.checked;
    
    try {
      console.log(`${paused ? 'Pausing' : 'Resuming'} auto-login`);
      
      const response = await chrome.runtime.sendMessage({ 
        type: 'toggle-pause', 
        paused: paused
      });
      
      if (!response || !response.success) {
        console.error('Failed to toggle pause state');
        // Revert toggle on error
        pauseToggle.checked = !paused;
      }
      
    } catch (error) {
      console.error('Toggle pause error:', error);
      // Revert toggle on error
      pauseToggle.checked = !paused;
    }
  });
}

// Handle options link
if (optionsLink) {
  optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    
    try {
      chrome.runtime.openOptionsPage();
      // Close popup after opening options
      window.close();
    } catch (error) {
      console.error('Error opening options page:', error);
    }
  });
}

// Listen for state updates from background
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'state-update' && message.state) {
    console.log('Received state update:', message.state.status);
    updateUI(message.state);
  }
});

// Handle popup focus/blur for better UX
window.addEventListener('focus', () => {
  console.log('Popup focused, refreshing state');
  loadState();
});

// Clean up on unload
window.addEventListener('unload', () => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});

// Handle errors in the popup
window.addEventListener('error', (event) => {
  console.error('Popup error:', event.error);
  
  if (statusText) {
    statusText.textContent = 'Script Error';
  }
  
  if (statusChip) {
    statusChip.className = 'status-chip error';
  }
});

// Add keyboard shortcuts for popup
document.addEventListener('keydown', (e) => {
  // Enter or Space to trigger force login
  if ((e.key === 'Enter' || e.key === ' ') && forceLoginBtn && !forceLoginBtn.disabled) {
    e.preventDefault();
    forceLoginBtn.click();
  }
  
  // Escape to close popup
  if (e.key === 'Escape') {
    window.close();
  }
  
  // 'o' to open options
  if (e.key === 'o' || e.key === 'O') {
    if (optionsLink) {
      optionsLink.click();
    }
  }
  
  // 'p' to toggle pause
  if (e.key === 'p' || e.key === 'P') {
    if (pauseToggle) {
      pauseToggle.checked = !pauseToggle.checked;
      pauseToggle.dispatchEvent(new Event('change'));
    }
  }
});

// Add debug methods for development
if (typeof window !== 'undefined') {
  window.debugPopup = {
    async getState() {
      try {
        return await chrome.runtime.sendMessage({ type: 'get-state' });
      } catch (error) {
        console.error('Debug get state error:', error);
        return null;
      }
    },
    
    async forceLogin() {
      try {
        return await chrome.runtime.sendMessage({ type: 'force-login' });
      } catch (error) {
        console.error('Debug force login error:', error);
        return null;
      }
    },
    
    refreshUI() {
      loadState();
    }
  };
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}