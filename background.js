let creatingPromise = null;
let isConnected = false;

async function setupOffscreenDocument(path) {
  const offscreenUrl = chrome.runtime.getURL(path);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) return;

  if (creatingPromise) {
    await creatingPromise;
    return;
  }

  creatingPromise = chrome.offscreen.createDocument({
    url: path,
    reasons: ['CLIPBOARD'],
    justification: 'To manage WebRTC peer connections and access the system clipboard in the background.'
  });

  await creatingPromise;
  creatingPromise = null;
}

async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

const defaultIcon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABjklEQVR42u3BAQEAAACAkP6v7ggKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwGwwEAAZ9h31QAAAAASUVORK5CYII=';

async function getIconDataUrl() {
  return defaultIcon;
}

function addToHistory(clip) {
  chrome.storage.local.get(['history'], (data) => {
    let history = data.history || [];
    
    // Deduplicate by the actual data field for each clip type.
    // Files use 'fileData'; everything else uses 'content'.
    // Previously this always compared h.content === clip.content, which meant
    // file clips (where content is undefined) matched every other file clip —
    // making the guard useless and allowing duplicates through.
    let existing;
    if (clip.type === 'file') {
      existing = history.find(h => h.type === 'file' && h.fileData === clip.fileData && h.fileName === clip.fileName);
    } else {
      existing = history.find(h => h.content === clip.content);
    }

    if (existing) {
       // if within 5 seconds, ignore
       if (Math.abs(existing.timestamp - clip.timestamp) < 5000) return;
    }
    
    history.unshift(clip);
    if (history.length > 50) history = history.slice(0, 50);
    chrome.storage.local.set({ history });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CONNECT') {
    (async () => {
      await setupOffscreenDocument('offscreen.html');
      chrome.runtime.sendMessage({
        type: 'CONNECT_OFFSCREEN',
        roomCode: message.roomCode,
        username: message.username
      }).catch(() => {});
      sendResponse({ success: true });
    })();
    return true;
  }
  
  if (message.type === 'DISCONNECT') {
    (async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'DISCONNECT_OFFSCREEN' });
      } catch (e) {}
      isConnected = false;
      await chrome.storage.local.set({ status: 'Disconnected', onlineUsers: [] });
      await closeOffscreenDocument();
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.type === 'STATUS_UPDATE') {
    isConnected = message.status === 'Connected';
    chrome.storage.local.set({ status: message.status });
  }
  
  else if (message.type === 'PARTICIPANTS_UPDATE') {
    chrome.storage.local.set({
      onlineUsers: message.names,
      onlineUserDeviceTypes: message.deviceTypes || {}
    });
  }

  else if (message.type === 'SAVE_CLIP') {
    // Received from peer
    const clip = message.clip;
    addToHistory(clip);

    (async () => {
      try {
        const iconUrl = await getIconDataUrl();
        if (iconUrl) {
          const isImage = clip.type === 'image/png';
          
          if (clip.type === 'text/url') {
            chrome.notifications.create({
              type: 'basic',
              iconUrl: iconUrl,
              title: clip.target ? `Private Tab from ${clip.sender || 'Unknown'}` : `New Shared Tab from ${clip.sender || 'Unknown'}`,
              message: 'Click the extension to open: ' + clip.content.substring(0, 50)
            });
          } else if (clip.type === 'file') {
            chrome.notifications.create({
              type: 'basic',
              iconUrl: iconUrl,
              title: clip.target ? `Private File from ${clip.sender || 'Unknown'}` : `New File from ${clip.sender || 'Unknown'}`,
              message: `[File Received] ${clip.fileName}`
            });
          } else {
            chrome.notifications.create({
              type: 'basic',
              iconUrl: iconUrl,
              title: clip.target ? `Private Message from ${clip.sender || 'Unknown'}` : `New Clip from ${clip.sender || 'Unknown'}`,
              message: isImage ? '[Image Received]' : clip.content.substring(0, 50) + (clip.content.length > 50 ? '...' : '')
            });
          }
        }
      } catch (e) {
        console.error('Notification failed', e);
      }
    })();
  }
  
  else if (message.type === 'LOCAL_CLIP_DETECTED' || message.type === 'BROADCAST_AND_SAVE_CLIP') {
    chrome.storage.local.get(['username'], (data) => {
      const username = data.username || 'Anonymous';
      const timestamp = Date.now();
      
      const clipData = message.clipData;
      clipData.sender = username;
      clipData.timestamp = timestamp;
      
      // Build the history entry correctly for each clip type.
      // Files need fileData/fileName/mimeType preserved — the generic
      // `content` field only applies to text and image clips.
      let historyEntry;
      if (clipData.type === 'image/png') {
        historyEntry = { type: 'image/png', content: clipData.dataUrl, sender: username, timestamp };
      } else if (clipData.type === 'file') {
        historyEntry = {
          type: 'file',
          fileData: clipData.fileData,
          fileName: clipData.fileName,
          mimeType: clipData.mimeType,
          sender: username,
          timestamp
        };
      } else {
        historyEntry = { type: clipData.type, content: clipData.text, sender: username, timestamp };
      }
      
      // Save locally
      addToHistory(historyEntry);
      
      // Forward to offscreen to broadcast over WebRTC
      chrome.runtime.sendMessage({
        type: 'BROADCAST_CLIP',
        clipData: clipData
      }).catch(() => {});
    });
  }
});
