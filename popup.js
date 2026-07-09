const usernameInput = document.getElementById('username');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const historyList = document.getElementById('historyList');
const manualInput = document.getElementById('manualInput');
const sendBtn = document.getElementById('sendBtn');
const userGroup = document.getElementById('userGroup');

// Load saved username or prompt for it on first run
chrome.storage.local.get(['username'], (data) => {
  if (data.username) {
    usernameInput.value = data.username;
  } else {
    // First time running!
    const name = prompt("Welcome to LAN Clipboard!\\n\\nPlease enter your name (e.g. John's Mac):");
    if (name) {
      usernameInput.value = name;
      chrome.storage.local.set({ username: name.trim() });
    }
  }
});

usernameInput.addEventListener('change', () => {
  chrome.storage.local.set({ username: usernameInput.value.trim() });
});

function formatTime(ts) {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function updateUI() {
  const data = await chrome.storage.local.get(['status', 'history']);
  
  if (data.status) {
    statusText.textContent = data.status;
    let stClass = '';
    if (data.status === 'Connected to partner') stClass = 'connected';
    else if (data.status === 'Waiting for partner...') stClass = 'waiting';
    else if (data.status === 'Error') stClass = 'error';
    statusIndicator.className = 'status-container ' + stClass;
    
    if (data.status === 'Connected to partner' || data.status === 'Waiting for partner...' || data.status === 'Connecting...') {
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'block';
      userGroup.style.display = 'none';
    } else {
      connectBtn.style.display = 'block';
      disconnectBtn.style.display = 'none';
      userGroup.style.display = 'block';
    }
    
    if (data.status === 'Connected to partner') {
      sendBtn.disabled = false;
    } else {
      sendBtn.disabled = true;
    }
  }

  if (data.history) {
    historyList.innerHTML = '';
    data.history.forEach(item => {
      // Backwards compatibility for old string array format
      if (typeof item === 'string') {
        item = { type: item.startsWith('data:image/') ? 'image/png' : 'text/plain', content: item, sender: 'Unknown', timestamp: Date.now() };
      }

      const li = document.createElement('li');
      li.className = 'history-item';
      
      const meta = document.createElement('div');
      meta.className = 'history-item-meta';
      const senderSpan = document.createElement('span');
      senderSpan.style.color = '#3b82f6';
      senderSpan.textContent = item.sender || 'Anonymous';
      const timeSpan = document.createElement('span');
      timeSpan.textContent = formatTime(item.timestamp);
      meta.appendChild(senderSpan);
      meta.appendChild(timeSpan);
      li.appendChild(meta);

      const contentDiv = document.createElement('div');
      contentDiv.className = 'history-item-content';
      
      if (item.type === 'image/png') {
        const img = document.createElement('img');
        img.src = item.content;
        contentDiv.appendChild(img);
        
        li.title = 'Click to copy image';
        li.onclick = () => {
           fetch(item.content)
             .then(res => res.blob())
             .then(blob => {
               const clipItem = new ClipboardItem({ [blob.type]: blob });
               return navigator.clipboard.write([clipItem]);
             })
             .then(() => {
               contentDiv.innerHTML = '<span style="font-size:12px; font-weight: 500; color: #10b981;">Copied image!</span>';
               setTimeout(() => { contentDiv.innerHTML = ''; contentDiv.appendChild(img); }, 1000);
             })
             .catch(e => {
               console.error(e);
               contentDiv.innerHTML = '<span style="font-size:12px; font-weight: 500; color: #ef4444;">Failed to copy</span>';
               setTimeout(() => { contentDiv.innerHTML = ''; contentDiv.appendChild(img); }, 1000);
             });
        };
      } else {
        contentDiv.classList.add('text-item');
        contentDiv.textContent = item.content;
        li.title = 'Click to copy text';
        li.onclick = () => {
          navigator.clipboard.writeText(item.content);
          contentDiv.textContent = 'Copied!';
          contentDiv.style.color = '#10b981';
          contentDiv.style.fontWeight = '500';
          setTimeout(() => { 
            contentDiv.textContent = item.content; 
            contentDiv.style.color = '';
            contentDiv.style.fontWeight = '';
          }, 1000);
        };
      }
      li.appendChild(contentDiv);
      historyList.appendChild(li);
    });
  }
}

connectBtn.addEventListener('click', async () => {
  const username = usernameInput.value.trim() || 'Anonymous';
  await chrome.storage.local.set({ username });
  
  const roomCode = 'default-lan-room';
  await chrome.storage.local.set({ roomCode, status: 'Connecting...' });
  updateUI();
  chrome.runtime.sendMessage({ type: 'CONNECT', roomCode });
});

disconnectBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ status: 'Disconnected' });
  updateUI();
  chrome.runtime.sendMessage({ type: 'DISCONNECT' });
});

// Poll for updates (status and history)
setInterval(updateUI, 1000);
updateUI();

const clearHistoryBtn = document.getElementById('clearHistoryBtn');
if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', () => {
    if (confirm('Clear the clipboard history and release memory?')) {
      chrome.storage.local.set({ history: [] }, () => {
        updateUI();
      });
    }
  });
}

sendBtn.addEventListener('click', async () => {
  if (sendBtn.disabled) return;
  const img = manualInput.querySelector('img');
  
  if (img) {
    const src = img.src;
    if (src.startsWith('data:image/')) {
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';
      try {
        chrome.runtime.sendMessage({ 
          type: 'BROADCAST_AND_SAVE_CLIP', 
          clipData: { type: 'image/png', dataUrl: src }
        });
        
        manualInput.innerHTML = ''; // clear input
      } catch (e) {
        console.error(e);
        alert('Failed to send image');
      }
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
  } else {
    // Handle text
    const text = manualInput.innerText.trim();
    if (text) {
      chrome.runtime.sendMessage({ 
        type: 'BROADCAST_AND_SAVE_CLIP', 
        clipData: { type: 'text/plain', text }
      });
      manualInput.innerHTML = ''; // clear input
    }
  }
});
