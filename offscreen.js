let peer = null;
let connections = []; // For host to keep track of clients
let isHost = false;
let hostConn = null; // For client to keep track of host
let roomCode = '';
let lastClipboardSignature = null;
let pollInterval = null;

async function broadcast(data) {
  let sendData = data;
  if (data.type === 'image/png' && data.dataUrl) {
    try {
      const res = await fetch(data.dataUrl);
      const buffer = await res.arrayBuffer();
      sendData = {
        type: 'image/png',
        buffer: buffer,
        sender: data.sender,
        timestamp: data.timestamp
      };
    } catch (e) {
      console.error("Failed to convert image for WebRTC", e);
    }
  }

  if (isHost) {
    connections.forEach(c => { if (c.open) c.send(sendData); });
  } else if (hostConn && hostConn.open) {
    hostConn.send(sendData);
  }
}

async function handleIncomingData(data) {
  try {
    if (data.type === 'text/plain') {
      const signature = 'text:' + data.text;
      if (signature === lastClipboardSignature) return;
      
      if (isHost) connections.forEach(c => { if (c.open) c.send(data); });
      
      lastClipboardSignature = signature;
      
      navigator.clipboard.writeText(data.text).catch(err => {
        const ta = document.createElement('textarea');
        ta.value = data.text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      });
      
      chrome.runtime.sendMessage({ 
        type: 'SAVE_CLIP', 
        clip: { type: 'text/plain', content: data.text, sender: data.sender, timestamp: data.timestamp } 
      });
    } else if (data.type === 'image/png') {
      let dataUrl = data.dataUrl;
      if (data.buffer) {
        const blob = new Blob([data.buffer], { type: 'image/png' });
        dataUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      }
      
      if (!dataUrl) return;

      const signature = 'image:' + dataUrl.length;
      if (signature === lastClipboardSignature) return;
      
      if (isHost) connections.forEach(c => { if (c.open) c.send(data); });
      
      lastClipboardSignature = signature;
      
      try {
        const res = await fetch(dataUrl);
        const blob = await res.blob();
        const item = new ClipboardItem({ 'image/png': blob });
        await navigator.clipboard.write([item]);
      } catch (e) {
        if (e.name !== 'NotAllowedError' && e.name !== 'DOMException') {
          console.error("Clipboard write failed", e);
        }
      }
      
      chrome.runtime.sendMessage({ 
        type: 'SAVE_CLIP', 
        clip: { type: 'image/png', content: dataUrl, sender: data.sender, timestamp: data.timestamp } 
      });
    }
  } catch (e) {
    if (e.name !== 'NotAllowedError' && e.name !== 'DOMException') {
      console.error("Clipboard write failed", e);
    }
  }
}

// Polling local clipboard using execCommand fallback
async function readClipboardData() {
  return new Promise((resolve) => {
    const onPaste = (e) => {
      e.preventDefault();
      document.removeEventListener('paste', onPaste);
      
      const items = e.clipboardData.items;
      if (!items || items.length === 0) {
        resolve(null);
        return;
      }
      
      let hasImage = false;
      for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
          hasImage = true;
          const blob = item.getAsFile();
          const reader = new FileReader();
          reader.onload = () => resolve({ type: 'image', data: reader.result }); // data URL
          reader.readAsDataURL(blob);
          return;
        }
      }
      
      if (!hasImage) {
        const text = e.clipboardData.getData('text/plain');
        if (text) {
          resolve({ type: 'text', data: text });
          return;
        }
      }
      resolve(null);
    };
    
    document.addEventListener('paste', onPaste);
    
    // Safety timeout in case paste event never fires
    setTimeout(() => {
      document.removeEventListener('paste', onPaste);
      resolve(null);
    }, 200);
    
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    const success = document.execCommand('paste');
    document.body.removeChild(ta);
    
    if (!success) {
      document.removeEventListener('paste', onPaste);
      resolve(null);
    }
  });
}

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  
  readClipboardData().then(data => {
    if (data) {
      lastClipboardSignature = data.type === 'text' ? 'text:' + data.data : 'image:' + data.data.length;
    }
    
    pollInterval = setInterval(async () => {
      const data = await readClipboardData();
      if (!data) return;
      
      const sig = data.type === 'text' ? 'text:' + data.data : 'image:' + data.data.length;
      if (sig !== lastClipboardSignature) {
        lastClipboardSignature = sig;
        
        if (data.type === 'text') {
          chrome.runtime.sendMessage({ 
            type: 'LOCAL_CLIP_DETECTED', 
            clipData: { type: 'text/plain', text: data.data } 
          });
        } else {
          chrome.runtime.sendMessage({ 
            type: 'LOCAL_CLIP_DETECTED', 
            clipData: { type: 'image/png', dataUrl: data.data }
          });
        }
      }
    }, 1000);
  });
}

function cleanup() {
  if (pollInterval) clearInterval(pollInterval);
  if (peer) peer.destroy();
  connections = [];
  hostConn = null;
  isHost = false;
}

function setupPeer(code) {
  cleanup();
  roomCode = code;
  const hostId = roomCode + '-lan-clipboard-host';
  
  peer = new Peer();
  
  peer.on('open', (id) => {
    hostConn = peer.connect(hostId);
    
    hostConn.on('open', () => {
      isHost = false;
      startPolling();
      chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Connected' });
    });

    hostConn.on('data', handleIncomingData);
    
    hostConn.on('close', () => {
      chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Disconnected' });
      cleanup();
    });
  });

  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') {
      peer.destroy();
      
      peer = new Peer(hostId);
      peer.on('open', () => {
        isHost = true;
        startPolling();
        chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Connected' });
      });

      peer.on('connection', (conn) => {
        connections.push(conn);
        conn.on('data', handleIncomingData);
        conn.on('close', () => {
          connections = connections.filter(c => c !== conn);
        });
      });
      
      peer.on('error', (e) => {
         console.error('Host peer error', e);
         chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Error' });
      });
    } else {
      console.error('Client peer error', err);
      chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Error' });
    }
  });
}

function generateIcon() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  
  ctx.fillStyle = '#3b82f6';
  ctx.beginPath();
  ctx.roundRect(0, 0, 128, 128, 20);
  ctx.fill();
  
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.roundRect(30, 40, 68, 68, 8);
  ctx.fill();
  
  ctx.fillStyle = '#1e3a8a';
  ctx.beginPath();
  ctx.roundRect(44, 20, 40, 30, 10);
  ctx.fill();
  
  return canvas.toDataURL('image/png');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CONNECT_OFFSCREEN') {
    setupPeer(message.roomCode);
    sendResponse({ success: true });
  } else if (message.type === 'DISCONNECT_OFFSCREEN') {
    cleanup();
    sendResponse({ success: true });
  } else if (message.type === 'GENERATE_ICON') {
    sendResponse({ dataUrl: generateIcon() });
  } else if (message.type === 'BROADCAST_CLIP') {
    broadcast(message.clipData);
  }
});
