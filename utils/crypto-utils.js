// crypto-utils.js - Enhanced encryption utilities for SSO credentials

const CRYPTO_CONFIG = {
  name: 'AES-GCM',
  length: 256,
  ivLength: 12,
  saltLength: 16,
  iterations: 100000
};

export class CredentialManager {
  constructor() {
    this.initialized = false;
    this.keyMaterial = null;
    this.initializationPromise = null;
  }

  async initialize() {
    // Prevent multiple initialization attempts
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    
    if (this.initialized) {
      return Promise.resolve();
    }
    
    this.initializationPromise = this._doInitialize();
    return this.initializationPromise;
  }

  async _doInitialize() {
    try {
      const extensionId = chrome.runtime.id;
      const encoder = new TextEncoder();
      
      // Create a unique key for this installation
      const keyString = extensionId + (navigator.userAgent || 'default-ua');
      const baseKey = await crypto.subtle.digest('SHA-256', encoder.encode(keyString));
      
      this.keyMaterial = await crypto.subtle.importKey(
        'raw',
        baseKey,
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
      );
      
      this.initialized = true;
      console.log('CredentialManager initialized successfully');
      
    } catch (error) {
      console.error('CredentialManager initialization failed:', error);
      this.initializationPromise = null; // Allow retry
      throw error;
    }
  }

  async getEncryptionKey() {
    await this.initialize();
    const salt = await this.getOrCreateSalt();
    
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: CRYPTO_CONFIG.iterations,
        hash: 'SHA-256'
      },
      this.keyMaterial,
      { name: CRYPTO_CONFIG.name, length: CRYPTO_CONFIG.length },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async getOrCreateSalt() {
    try {
      const { salt } = await chrome.storage.local.get('salt');
      
      if (salt && Array.isArray(salt) && salt.length === CRYPTO_CONFIG.saltLength) {
        return new Uint8Array(salt);
      }
      
      // Generate new salt
      const newSalt = crypto.getRandomValues(new Uint8Array(CRYPTO_CONFIG.saltLength));
      await chrome.storage.local.set({ salt: Array.from(newSalt) });
      console.log('Generated new encryption salt');
      return newSalt;
      
    } catch (error) {
      console.error('Error managing salt:', error);
      // Fallback to a temporary salt (not ideal but better than failing)
      return crypto.getRandomValues(new Uint8Array(CRYPTO_CONFIG.saltLength));
    }
  }

  async encryptCredentials(username, password) {
    try {
      if (!username || !password) {
        throw new Error('Username and password are required');
      }
      
      await this.initialize();
      const key = await this.getEncryptionKey();
      const encoder = new TextEncoder();
      
      const credentials = JSON.stringify({ 
        username: username.trim(), 
        password: password,
        version: '1.0' // For future migration compatibility
      });
      
      const iv = crypto.getRandomValues(new Uint8Array(CRYPTO_CONFIG.ivLength));
      
      const encrypted = await crypto.subtle.encrypt(
        { name: CRYPTO_CONFIG.name, iv },
        key,
        encoder.encode(credentials)
      );
      
      // Combine IV and encrypted data
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(encrypted), iv.length);
      
      const result = {
        data: btoa(String.fromCharCode(...combined)),
        timestamp: Date.now(),
        version: '1.0'
      };
      
      console.log('Credentials encrypted successfully');
      return result;
      
    } catch (error) {
      console.error('Encryption failed:', error);
      throw new Error('Failed to encrypt credentials: ' + error.message);
    }
  }

  async decryptCredentials(encryptedData) {
    try {
      if (!encryptedData || !encryptedData.data) {
        console.warn('No encrypted data provided');
        return null;
      }
      
      await this.initialize();
      const key = await this.getEncryptionKey();
      
      // Decode base64
      let combined;
      try {
        combined = Uint8Array.from(atob(encryptedData.data), c => c.charCodeAt(0));
      } catch (error) {
        throw new Error('Invalid encrypted data format');
      }
      
      if (combined.length < CRYPTO_CONFIG.ivLength) {
        throw new Error('Encrypted data is too short');
      }
      
      // Extract IV and encrypted data
      const iv = combined.slice(0, CRYPTO_CONFIG.ivLength);
      const encrypted = combined.slice(CRYPTO_CONFIG.ivLength);
      
      // Decrypt
      const decrypted = await crypto.subtle.decrypt(
        { name: CRYPTO_CONFIG.name, iv },
        key,
        encrypted
      );
      
      // Parse JSON
      const credentialsString = new TextDecoder().decode(decrypted);
      const credentials = JSON.parse(credentialsString);
      
      // Validate structure
      if (!credentials.username || !credentials.password) {
        throw new Error('Invalid credentials structure');
      }
      
      console.log('Credentials decrypted successfully');
      return {
        username: credentials.username,
        password: credentials.password
      };
      
    } catch (error) {
      console.error('Decryption failed:', error);
      
      // Provide more specific error messages
      if (error.name === 'OperationError') {
        throw new Error('Invalid credentials or corrupted data');
      } else if (error.message.includes('JSON')) {
        throw new Error('Corrupted credential data');
      } else {
        throw new Error('Failed to decrypt credentials: ' + error.message);
      }
    }
  }

  // Test method to verify encryption/decryption works
  async testEncryption() {
    try {
      const testUsername = 'test_user';
      const testPassword = 'test_pass_123';
      
      const encrypted = await this.encryptCredentials(testUsername, testPassword);
      const decrypted = await this.decryptCredentials(encrypted);
      
      const success = decrypted.username === testUsername && decrypted.password === testPassword;
      console.log('Encryption test:', success ? 'PASSED' : 'FAILED');
      return success;
      
    } catch (error) {
      console.error('Encryption test failed:', error);
      return false;
    }
  }

  // Clear all stored encryption data (for debugging/reset)
  async clearStoredData() {
    try {
      await chrome.storage.local.remove(['encryptedCreds', 'salt']);
      this.initialized = false;
      this.keyMaterial = null;
      this.initializationPromise = null;
      console.log('Encryption data cleared');
    } catch (error) {
      console.error('Failed to clear encryption data:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const credentialManager = new CredentialManager();

//