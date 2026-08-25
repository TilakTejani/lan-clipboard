let peer = null;
let connections = []; // For host to keep track of clients
let isHost = false;
let hostConn = null; // For client to keep track of host
let roomCode = '';
let lastClipboardSignature = null;
let pollInterval = null;
let myName = 'Anonymous';

function detectDeviceType() {
  const ua = navigator.userAgent || '';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/CrOS/i.test(ua)) return 'ChromeOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Desktop';
}
const myDeviceType = detectDeviceType();

// WebRTC data channels have real per-message size limits; pushing a large
// file/image through as a single message can destabilize the whole peer
// connection. Anything over this size gets split into small 'file_chunk'
// messages and reassembled on the other end instead.
const CHUNK_SIZE = 16000;
let chunkBuffers = {}; // transferId -> { total, chunks: [] }

/**
 * Converts a data: URL to a Blob without using fetch(), which is unreliable
 * inside Chrome offscreen documents (fetch on data: URLs can fail silently).
 */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.substring(0, comma);
  const base64 = dataUrl.substring(comma + 1);
  const mimeMatch = header.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * Converts any image data: URL (JPEG, WEBP, GIF, etc.) to an image/png Blob
 * suitable for navigator.clipboard.write().
 *
 * Chrome's ClipboardItem strictly validates that the Blob's MIME type matches
 * the key string — passing a JPEG blob as { 'image/png': jpegBlob } throws
 * DOMException: "Unable to download all specified images".
 *
 * If the source is already PNG this skips the canvas round-trip.
 */
function dataUrlToPngBlob(dataUrl) {
  if (dataUrl.startsWith('data:image/png')) {
    return Promise.resolve(dataUrlToBlob(dataUrl));
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('canvas.toBlob failed — image may be tainted or empty'));
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('Image failed to load for PNG conversion'));
    img.src = dataUrl;
  });
}

function sendToTargets(payload) {
  if (isHost) {
    connections.forEach(c => {
      if (c.open) {
        if (payload.target && c.partnerName !== payload.target && c.partnerName !== payload.sender) return;
        try {
          c.send(payload);
        } catch (e) {
          console.error('Failed to send payload to peer', c.peer, e);
        }
      }
    });
  } else if (hostConn && hostConn.open) {
    try {
      hostConn.send(payload);
    } catch (e) {
      console.error('Failed to send payload to host', e);
    }
  }
}

async function broadcastChunked(originalType, payload, meta) {
  const transferId = Date.now() + '-' + Math.random().toString(36).slice(2);
  const total = Math.ceil(payload.length / CHUNK_SIZE);

  for (let i = 0; i < total; i++) {
    const chunk = payload.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    sendToTargets({
      type: 'file_chunk',
      transferId,
      index: i,
      total,
      chunk,
      originalType,
      ...meta
    });
    
    // Yield to the event loop after EVERY chunk to let the WebRTC buffer drain.
    // Chrome WebRTC can silently drop packets if dataChannel.send() is called
    // too many times synchronously in a tight loop.
    await new Promise(r => setTimeout(r, 2));
  }
}

async function broadcast(data) {
  if (data.type === 'file' && data.fileData && data.fileData.length > CHUNK_SIZE) {
    await broadcastChunked('file', data.fileData, {
      fileName: data.fileName,
      mimeType: data.mimeType,
      sender: data.sender,
      timestamp: data.timestamp,
      target: data.target
    });
    return;
  }

  if (data.type === 'image/png' && data.dataUrl && data.dataUrl.length > CHUNK_SIZE) {
    await broadcastChunked('image/png', data.dataUrl, {
      sender: data.sender,
      timestamp: data.timestamp,
      target: data.target
    });
    return;
  }

  if (data.type === 'text/plain' && data.text && data.text.length > CHUNK_SIZE) {
    await broadcastChunked('text/plain', data.text, {
      sender: data.sender,
      timestamp: data.timestamp,
      target: data.target
    });
    return;
  }

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

  sendToTargets(sendData);
}

async function handleIncomingData(data, sourceConn) {
  try {
    console.log(`[offscreen] handleIncomingData received type: ${data.type}`, data.type === 'file_chunk' ? `index: ${data.index}/${data.total}` : '');
    
    if (data.type === 'HANDSHAKE') {
      console.log(`[RoomEntry] HANDSHAKE received: username="${data.username}" deviceType="${data.deviceType}" from peer="${sourceConn ? sourceConn.peer : 'unknown'}"`);
      if (sourceConn) {
        sourceConn.partnerName = data.username || 'Partner';
        sourceConn.partnerDeviceType = data.deviceType || 'Unknown';
      }
      if (isHost) {
        broadcastParticipants();
      } else {
        const partnerName = data.username || 'Partner';
        chrome.runtime.sendMessage({
          type: 'PARTICIPANTS_UPDATE',
          names: [partnerName],
          deviceTypes: { [partnerName]: data.deviceType || 'Unknown' }
        });
        chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Connected' });
      }
      return;
    }

    if (data.type === 'PARTICIPANTS') {
      const others = data.names.filter(n => n !== myName);
      chrome.runtime.sendMessage({
        type: 'PARTICIPANTS_UPDATE',
        names: others,
        deviceTypes: data.deviceTypes || {}
      });
      chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Connected' });
      return;
    }

    if (data.type === 'text/plain') {
      console.log(`[offscreen] Received text/plain: length ${data.text ? data.text.length : 'undefined'}, target: ${data.target}`);
      if (isHost) connections.forEach(c => { 
        if (c.open && c !== sourceConn) {
          if (data.target && c.partnerName !== data.target && c.partnerName !== data.sender) return;
          c.send(data); 
        }
      });
      
      if (data.target && data.target !== myName && data.sender !== myName) {
        console.log(`[offscreen] Ignoring text/plain as it is targeted for ${data.target} and I am ${myName}`);
        return;
      }

      const signature = 'text:' + data.text;
      if (signature === lastClipboardSignature) {
        console.log(`[offscreen] Ignoring text/plain as it matches lastClipboardSignature`);
        return;
      }
      lastClipboardSignature = signature;
      
      console.log(`[offscreen] Attempting to copy text/plain to clipboard`);
      navigator.clipboard.writeText(data.text).catch(err => {
        console.log(`[offscreen] navigator.clipboard.writeText failed, falling back to execCommand`, err);
        const ta = document.createElement('textarea');
        ta.value = data.text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      });
      
      console.log(`[offscreen] Sending SAVE_CLIP for text/plain`);
      chrome.runtime.sendMessage({ 
        type: 'SAVE_CLIP', 
        clip: { type: 'text/plain', content: data.text, sender: data.sender, timestamp: data.timestamp, target: data.target } 
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

      if (isHost) connections.forEach(c => { 
        if (c.open && c !== sourceConn) {
          if (data.target && c.partnerName !== data.target && c.partnerName !== data.sender) return;
          c.send(data); 
        }
      });

      if (data.target && data.target !== myName && data.sender !== myName) return;

      const signature = 'image:' + dataUrl.length;
      if (signature === lastClipboardSignature) return;
      lastClipboardSignature = signature;
      
      try {
        const blob = await dataUrlToPngBlob(dataUrl);
        const item = new ClipboardItem({ 'image/png': blob });
        await navigator.clipboard.write([item]);
      } catch (e) {
        // Suppress focus/permission errors — these are expected when the
        // extension popup isn't focused. Log everything else.
        if (e.name !== 'NotAllowedError') {
          console.error('Clipboard write failed', e);
        }
      }
      
      chrome.runtime.sendMessage({ 
        type: 'SAVE_CLIP', 
        clip: { type: 'image/png', content: dataUrl, sender: data.sender, timestamp: data.timestamp, target: data.target } 
      });
    } else if (data.type === 'file') {
      if (isHost) connections.forEach(c => { 
        if (c.open && c !== sourceConn) {
          if (data.target && c.partnerName !== data.target && c.partnerName !== data.sender) return;
          c.send(data); 
        }
      });

      if (data.target && data.target !== myName && data.sender !== myName) return;

      const signature = 'file:' + data.fileName + ':' + data.fileData.length;
      if (signature === lastClipboardSignature) return;
      lastClipboardSignature = signature;
      
      chrome.runtime.sendMessage({
        type: 'SAVE_CLIP',
        clip: { type: 'file', fileData: data.fileData, fileName: data.fileName, mimeType: data.mimeType, sender: data.sender, timestamp: data.timestamp, target: data.target }
      });
    } else if (data.type === 'file_chunk') {
      if (isHost) connections.forEach(c => {
        if (c.open && c !== sourceConn) {
          if (data.target && c.partnerName !== data.target && c.partnerName !== data.sender) return;
          try {
            c.send(data);
          } catch (e) {
            console.error('Failed to forward chunk to peer', c.peer, e);
          }
        }
      });

      // Early-exit BEFORE buffering: if the chunk is addressed to a specific
      // peer that isn't us, the host has already forwarded it above — there's
      // no reason to buffer any part of it in memory.
      if (data.target && data.target !== myName && data.sender !== myName) return;

      // `new Array(data.total)` creates a sparse array — Array#some() skips
      // unset holes entirely instead of visiting them as undefined, so the
      // old `buf.chunks.some(c => c === undefined)` check returned false
      // (i.e. "complete") the moment a single chunk arrived, reassembling
      // just that one fragment and discarding the rest. Track a received
      // count instead so completion only fires once every index is filled.
      const buf = chunkBuffers[data.transferId] || (chunkBuffers[data.transferId] = { total: data.total, chunks: new Array(data.total), received: 0 });
      if (buf.chunks[data.index] === undefined) {
        buf.received++;
      }
      buf.chunks[data.index] = data.chunk;
      
      if (data.index % 10 === 0 || buf.received === buf.total) {
        console.log(`[offscreen] file_chunk progress: ${buf.received}/${buf.total}`);
      }
      
      if (buf.received < buf.total) return;

      console.log(`[offscreen] file_chunk complete, reassembling ${data.originalType}`);
      delete chunkBuffers[data.transferId];
      const fullPayload = buf.chunks.join('');

      if (data.originalType === 'image/png') {
        const signature = 'image:' + fullPayload.length;
        if (signature === lastClipboardSignature) return;
        lastClipboardSignature = signature;

        try {
          const blob = await dataUrlToPngBlob(fullPayload);
          const item = new ClipboardItem({ 'image/png': blob });
          await navigator.clipboard.write([item]);
        } catch (e) {
          if (e.name !== 'NotAllowedError') {
            console.error('Clipboard write failed', e);
          }
        }

        chrome.runtime.sendMessage({
          type: 'SAVE_CLIP',
          clip: { type: 'image/png', content: fullPayload, sender: data.sender, timestamp: data.timestamp, target: data.target }
        });
      } else if (data.originalType === 'text/plain') {
        const signature = 'text:' + fullPayload;
        if (signature === lastClipboardSignature) {
          console.log(`[offscreen] Ignoring chunked text/plain as it matches lastClipboardSignature`);
          return;
        }
        lastClipboardSignature = signature;
        
        console.log(`[offscreen] Attempting to copy chunked text/plain to clipboard`);
        navigator.clipboard.writeText(fullPayload).catch(err => {
          console.log(`[offscreen] chunked navigator.clipboard.writeText failed, falling back to execCommand`, err);
          const ta = document.createElement('textarea');
          ta.value = fullPayload;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        });
        
        console.log(`[offscreen] Sending SAVE_CLIP for chunked text/plain`);
        chrome.runtime.sendMessage({ 
          type: 'SAVE_CLIP', 
          clip: { type: 'text/plain', content: fullPayload, sender: data.sender, timestamp: data.timestamp, target: data.target } 
        });
      } else {
        const signature = 'file:' + data.fileName + ':' + fullPayload.length;
        if (signature === lastClipboardSignature) return;
        lastClipboardSignature = signature;

        chrome.runtime.sendMessage({
          type: 'SAVE_CLIP',
          clip: { type: 'file', fileData: fullPayload, fileName: data.fileName, mimeType: data.mimeType, sender: data.sender, timestamp: data.timestamp, target: data.target }
        });
      }
    }
  } catch (e) {
    if (e.name !== 'NotAllowedError' && e.name !== 'DOMException') {
      console.error("Clipboard write failed", e);
    }
  }
}

// Polling local clipboard using modern navigator.clipboard API
async function readClipboardData() {
  try {
    // Try reading text first (faster and less prone to permission errors)
    const text = await navigator.clipboard.readText();
    if (text) {
      return { type: 'text', data: text };
    }
  } catch (e) {
    // Fallback or ignore
  }
  
  try {
    // Try reading images
    const items = await navigator.clipboard.read();
    if (!items || items.length === 0) return null;
    
    for (const item of items) {
      const imageType = item.types.find(t => t.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ type: 'image', data: reader.result }); // data URL
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      }
    }
  } catch (e) {
    // Ignore errors (e.g., if clipboard is empty or unsupported format)
  }
  
  return null;
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

function broadcastParticipants() {
  if (!isHost) return;
  const names = [myName];
  const deviceTypes = { [myName]: myDeviceType };
  connections.forEach(c => {
    if (c.open && c.partnerName) {
      if (!names.includes(c.partnerName)) names.push(c.partnerName);
      deviceTypes[c.partnerName] = c.partnerDeviceType || 'Unknown';
    }
  });

  const others = names.filter(n => n !== myName);
  console.log(`[RoomEntry] broadcastParticipants: ready=${JSON.stringify(names)} total_connections=${connections.length} (${connections.length - (names.length - 1)} not yet open/handshaken)`);
  chrome.runtime.sendMessage({ type: 'PARTICIPANTS_UPDATE', names: others, deviceTypes });

  if (others.length === 0) {
    chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Waiting for partner...' });
  } else {
    chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Connected' });
  }

  connections.forEach(c => {
    if (c.open) c.send({ type: 'PARTICIPANTS', names, deviceTypes });
  });
}


function cleanup() {
  if (pollInterval) clearInterval(pollInterval);
  if (peer) peer.destroy();
  connections = [];
  hostConn = null;
  isHost = false;
}

function setupPeer(code, username) {
  cleanup();
  roomCode = code;
  myName = username || 'Anonymous';
  const hostId = roomCode + '-lan-clipboard-host';
  console.log(`[RoomEntry] setupPeer() room="${roomCode}" me="${myName}" hostId="${hostId}"`);

  // TEMP DIAGNOSTIC: verbose PeerJS/ICE logging to console while chasing the
  // extension-stuck-connecting issue. Revert to `new Peer()` once resolved.
  peer = new Peer(undefined, { debug: 3 });

  peer.on('open', (id) => {
    console.log(`[RoomEntry] signaling open, my peer id="${id}" — attempting connect() to hostId="${hostId}"`);
    // Explicit 'json' serialization: PeerJS's real default is its own
    // MessagePack-style binary packer (confirmed by reading peerjs.min.js's
    // serializer classes), NOT plain UTF-8 JSON bytes. The mobile app's
    // DataConnection.sendBinary()/_decodeAndHandle() only ever speak
    // TextEncoder(JSON.stringify(...)) — i.e. exactly PeerJS's 'json'
    // serializer's wire format. Without this, every message this side sends
    // silently fails to decode on the mobile end (caught and dropped with no
    // trace) — this was the actual root cause of the extension appearing
    // "stuck connecting" while mobile devices connect to each other fine.
    hostConn = peer.connect(hostId, { serialization: 'json' });

    hostConn.on('open', () => {
      console.log(`[RoomEntry] DataConnection to host OPEN — sending HANDSHAKE as "${myName}" (${myDeviceType})`);
      isHost = false;
      startPolling();
      chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Connecting...' });
      hostConn.send({ type: 'HANDSHAKE', username: myName, deviceType: myDeviceType });
    });

    hostConn.on('data', (data) => handleIncomingData(data, hostConn));

    hostConn.on('close', () => {
      console.log('[RoomEntry] DataConnection to host CLOSED');
      chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Disconnected' });
      cleanup();
    });
  });

  peer.on('error', (err) => {
    console.log(`[RoomEntry] signaling error: type="${err.type}" message="${err.message}"`);
    if (err.type === 'peer-unavailable') {
      console.log(`[RoomEntry] hostId="${hostId}" not registered yet — claiming host role`);
      // Deferred: destroying/recreating this peer synchronously inside its
      // own 'error' callback re-enters the event emitter mid-dispatch, which
      // can leave it in a bad state (the same hazard fixed on the mobile
      // side's peerdart usage).
      setTimeout(() => {
        peer.destroy();

        peer = new Peer(hostId, { debug: 3 });
        peer.on('open', () => {
          console.log(`[RoomEntry] became HOST for hostId="${hostId}"`);
          isHost = true;
          startPolling();
          chrome.runtime.sendMessage({ type: 'PARTICIPANTS_UPDATE', names: [], deviceTypes: {} });
          chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Waiting for partner...' });
        });

        peer.on('connection', (conn) => {
          console.log(`[RoomEntry] incoming connection request from peer="${conn.peer}" (signaling-level, data channel not open yet)`);
          connections.push(conn);

          const sendHandshake = () => {
            console.log(`[RoomEntry] DataConnection from peer="${conn.peer}" is now OPEN — sending HANDSHAKE as "${myName}" (${myDeviceType})`);
            conn.send({ type: 'HANDSHAKE', username: myName, deviceType: myDeviceType });
          };
          if (conn.open) sendHandshake();
          else conn.on('open', sendHandshake);

          conn.on('data', (data) => handleIncomingData(data, conn));
          conn.on('close', () => {
            console.log(`[RoomEntry] connection from peer="${conn.peer}" CLOSED`);
            connections = connections.filter(c => c !== conn);
            broadcastParticipants();
          });
        });

        peer.on('error', (e) => {
           console.error('Host peer error', e);
           chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', status: 'Error' });
        });
      }, 0);
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
    setupPeer(message.roomCode, message.username);
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
