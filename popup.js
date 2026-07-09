const usernameInput = document.getElementById('username');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const historyList = document.getElementById('historyList');
const manualInput = document.getElementById('manualInput');
const sendBtn = document.getElementById('sendBtn');
const shareTabBtn = document.getElementById('shareTabBtn');
const userGroup = document.getElementById('userGroup');
const displayUsername = document.getElementById('displayUsername');
const badgesContainer = document.getElementById('badgesContainer');

let currentOnlineUsers = [];
const mentionDropdown = document.getElementById('mentionDropdown');
let mentionIndex = -1;

function placeCaretAtEnd(el) {
    el.focus();
    if (typeof window.getSelection !== "undefined"
            && typeof document.createRange !== "undefined") {
        var range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

function updateTitle() {
  const name = usernameInput.value.trim();
  if (name) {
    displayUsername.textContent = name;
  } else {
    displayUsername.textContent = 'LAN Clipboard';
  }
}

// Load saved username or prompt for it on first run
chrome.storage.local.get(['username'], (data) => {
  if (data.username) {
    usernameInput.value = data.username;
    updateTitle();
  } else {
    // First time running!
    const name = prompt("Welcome to LAN Clipboard!\n\nPlease enter your name (e.g. John's Mac):");
    if (name) {
      usernameInput.value = name;
      chrome.storage.local.set({ username: name.trim() });
      updateTitle();
    }
  }
});

usernameInput.addEventListener('input', () => {
  updateTitle();
});

usernameInput.addEventListener('change', () => {
  chrome.storage.local.set({ username: usernameInput.value.trim() });
});

function formatTime(ts) {
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function updateUI() {
  const data = await chrome.storage.local.get(['status', 'history', 'onlineUsers']);
  
  if (data.status) {
    badgesContainer.innerHTML = '';
    let isActuallyConnected = false;

    if (data.status === 'Waiting for partner...') {
      badgesContainer.innerHTML = `<div class="badge badge-waiting"><div class="status-dot"></div>Waiting for others...</div>`;
    } else if (data.status === 'Connecting...') {
      badgesContainer.innerHTML = `<div class="badge badge-connecting"><div class="status-dot"></div>Connecting...</div>`;
    } else if (data.status === 'Disconnected' || data.status === 'Error') {
      badgesContainer.innerHTML = `<div class="badge badge-connecting"><div class="status-dot" style="background-color:#ef4444;"></div>${data.status}</div>`;
    } else {
      isActuallyConnected = true;
      const users = data.onlineUsers || [];
      currentOnlineUsers = users;
      if (users.length === 0) {
         badgesContainer.innerHTML = `<div class="badge badge-connected"><div class="status-dot"></div>Connected</div>`;
      } else {
         users.forEach(u => {
           const b = document.createElement('div');
           b.className = 'badge badge-connected';
           b.innerHTML = `<div class="status-dot"></div>${u}`;
           b.style.cursor = 'pointer';
           b.onclick = () => {
             manualInput.innerText += (manualInput.innerText.length > 0 && !manualInput.innerText.endsWith(' ') ? ' ' : '') + `@${u} `;
             placeCaretAtEnd(manualInput);
           };
           badgesContainer.appendChild(b);
         });
      }
    }
    
    const isNetworkActive = data.status !== 'Disconnected' && data.status !== 'Error';

    if (isNetworkActive) {
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = 'block';
      userGroup.style.display = 'none';
    } else {
      connectBtn.style.display = 'block';
      disconnectBtn.style.display = 'none';
      userGroup.style.display = 'block';
    }
    
    sendBtn.disabled = !isActuallyConnected;
    shareTabBtn.disabled = !isActuallyConnected;
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
      if (item.target) {
        li.classList.add('private-clip');
      }
      
      const meta = document.createElement('div');
      meta.className = 'history-item-meta';
      const senderSpan = document.createElement('span');
      senderSpan.style.color = '#3b82f6';
      senderSpan.innerHTML = item.sender || 'Anonymous';
      if (item.target) {
        senderSpan.innerHTML += `<span class="private-badge">Private to ${item.target}</span>`;
      }
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
      } else if (item.type === 'text/url') {
        contentDiv.classList.add('text-item');
        const a = document.createElement('a');
        a.href = item.content;
        a.target = '_blank';
        a.style.color = '#2563eb';
        a.style.textDecoration = 'underline';
        a.style.wordBreak = 'break-all';
        a.textContent = item.content;
        contentDiv.appendChild(a);
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
  chrome.runtime.sendMessage({ type: 'CONNECT', roomCode, username });
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
    let target = null;
    currentOnlineUsers.forEach(u => {
      if (text.includes(`@${u}`)) target = u;
    });

    if (text) {
      chrome.runtime.sendMessage({ 
        type: 'BROADCAST_AND_SAVE_CLIP', 
        clipData: { type: 'text/plain', text, target }
      });
      manualInput.innerHTML = ''; // clear input
    }
  }
});

manualInput.addEventListener('input', () => {
  const text = manualInput.innerText.replace(/[\n\r]+$/, '').replace(/\u00A0/g, ' ');
  const match = text.match(/@([\w\s']*)$/);
  if (match) {
    const query = match[1].toLowerCase();
    const matches = currentOnlineUsers.filter(u => u.toLowerCase().startsWith(query));
    if (matches.length > 0) {
      mentionDropdown.innerHTML = '';
      matches.forEach((u, idx) => {
        const div = document.createElement('div');
        div.className = 'mention-item';
        if (idx === 0) div.classList.add('selected');
        div.textContent = u;
        div.onmousedown = (e) => {
           e.preventDefault();
           insertMention(u);
        };
        mentionDropdown.appendChild(div);
      });
      mentionDropdown.style.display = 'block';
      mentionIndex = 0;
    } else {
      mentionDropdown.style.display = 'none';
      mentionIndex = -1;
    }
  } else {
    mentionDropdown.style.display = 'none';
    mentionIndex = -1;
  }
});

function insertMention(username) {
   const text = manualInput.innerText;
   const newText = text.replace(/@[\w\s']*$/, `@${username} `);
   manualInput.innerText = newText;
   mentionDropdown.style.display = 'none';
   mentionIndex = -1;
   placeCaretAtEnd(manualInput);
}

manualInput.addEventListener('keydown', (e) => {
  if (mentionDropdown.style.display === 'block') {
    const items = mentionDropdown.querySelectorAll('.mention-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (mentionIndex < items.length - 1) {
        items[mentionIndex].classList.remove('selected');
        mentionIndex++;
        items[mentionIndex].classList.add('selected');
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (mentionIndex > 0) {
        items[mentionIndex].classList.remove('selected');
        mentionIndex--;
        items[mentionIndex].classList.add('selected');
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      insertMention(items[mentionIndex].textContent);
      return;
    } else if (e.key === 'Escape') {
      mentionDropdown.style.display = 'none';
    }
  } else {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  }
});

manualInput.addEventListener('blur', () => {
  setTimeout(() => mentionDropdown.style.display = 'none', 100);
});

shareTabBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      chrome.runtime.sendMessage({ 
        type: 'BROADCAST_AND_SAVE_CLIP', 
        clipData: { 
          type: 'text/url', 
          text: tab.url,
          title: tab.title 
        }
      });
      
      const originalText = shareTabBtn.textContent;
      shareTabBtn.textContent = 'Sent!';
      shareTabBtn.style.backgroundColor = '#d1fae5';
      shareTabBtn.style.color = '#065f46';
      setTimeout(() => {
        shareTabBtn.textContent = originalText;
        shareTabBtn.style.backgroundColor = '';
        shareTabBtn.style.color = '';
      }, 2000);
    }
  } catch (e) {
    console.error('Failed to get tab info', e);
  }
});
