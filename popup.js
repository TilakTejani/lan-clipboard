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
           b.onclick = (e) => {
             e.preventDefault();
             manualInput.focus();
             placeCaretAtEnd(manualInput);
             const text = manualInput.textContent;
             const space = (text.length > 0 && !text.endsWith(' ') && !text.endsWith('\n') && !text.endsWith('\xA0')) ? ' ' : '';
             document.execCommand('insertText', false, `${space}@${u} `);
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
      } else if (item.type === 'file') {
        const a = document.createElement('a');
        a.href = item.fileData;
        a.download = item.fileName;
        a.textContent = `📎 Download ${item.fileName}`;
        a.style.color = '#2563eb';
        a.style.textDecoration = 'none';
        a.style.fontWeight = '600';
        a.style.display = 'inline-block';
        a.style.padding = '8px';
        a.style.backgroundColor = '#eff6ff';
        a.style.borderRadius = '6px';
        contentDiv.appendChild(a);
      } else {
        contentDiv.classList.add('text-item');
        
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        let originalText = item.content;
        
        if (urlRegex.test(originalText)) {
          let html = originalText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          html = html.replace(urlRegex, (url) => `<a href="${url}" target="_blank" style="color: #2563eb; text-decoration: underline;">${url}</a>`);
          contentDiv.innerHTML = html;
          
          const urls = originalText.match(urlRegex) || [];
          for (const url of urls) {
            if (url.match(/\.(jpeg|jpg|gif|png|webp)(\?.*)?$/i)) {
              const img = document.createElement('img');
              img.src = url;
              img.style.marginTop = '8px';
              img.style.display = 'block';
              img.style.maxWidth = '100%';
              img.style.borderRadius = '4px';
              contentDiv.appendChild(img);
            }
          }
        } else {
          contentDiv.textContent = item.content;
        }

        li.title = 'Click to copy text';
        li.onclick = (e) => {
          if (e.target.tagName === 'A' || e.target.tagName === 'IMG') return; // don't trigger copy when clicking a link/img
          
          navigator.clipboard.writeText(originalText);
          
          const originalNodes = Array.from(contentDiv.childNodes);
          contentDiv.innerHTML = '';
          contentDiv.textContent = 'Copied!';
          contentDiv.style.color = '#10b981';
          contentDiv.style.fontWeight = '500';
          setTimeout(() => { 
            contentDiv.innerHTML = '';
            originalNodes.forEach(n => contentDiv.appendChild(n));
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
    
    const tabOptionText = "Share Current Tab";
    const includeTabOption = query === '' || tabOptionText.toLowerCase().includes(query) || "tab".startsWith(query);
    
    if (matches.length > 0 || includeTabOption) {
      mentionDropdown.innerHTML = '';
      let idxCount = 0;
      matches.forEach((u) => {
        const div = document.createElement('div');
        div.className = 'mention-item';
        if (idxCount === 0) div.classList.add('selected');
        div.textContent = u;
        div.onmousedown = (e) => {
           e.preventDefault();
           insertMention(u);
        };
        mentionDropdown.appendChild(div);
        idxCount++;
      });
      
      if (includeTabOption) {
        const div = document.createElement('div');
        div.className = 'mention-item tab-option';
        if (idxCount === 0) div.classList.add('selected');
        div.innerHTML = `🌐 <strong>Current Tab URL</strong>`;
        div.onmousedown = (e) => {
           e.preventDefault();
           insertTabUrl();
        };
        mentionDropdown.appendChild(div);
      }
      
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

function deleteLastMention() {
   manualInput.focus();
   placeCaretAtEnd(manualInput);
   const text = manualInput.innerText.replace(/[\n\r]+$/, '').replace(/\u00A0/g, ' ');
   const match = text.match(/@([\w\s']*)$/);
   if (match) {
       for (let i = 0; i < match[0].length; i++) {
           document.execCommand('delete', false, null);
       }
   }
}

function insertMention(username) {
   deleteLastMention();
   document.execCommand('insertText', false, `@${username} `);
   mentionDropdown.style.display = 'none';
   mentionIndex = -1;
}

function insertTabUrl() {
   chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab && tab.url) {
         deleteLastMention();
         document.execCommand('insertText', false, tab.url + ' ');
      } else {
         deleteLastMention();
      }
      mentionDropdown.style.display = 'none';
      mentionIndex = -1;
   });
}

manualInput.addEventListener('keydown', (e) => {
  if (mentionDropdown.style.display === 'block') {
    const items = mentionDropdown.querySelectorAll('.mention-item');
    if (items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[mentionIndex].classList.remove('selected');
        mentionIndex = (mentionIndex + 1) % items.length;
        items[mentionIndex].classList.add('selected');
        items[mentionIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[mentionIndex].classList.remove('selected');
        mentionIndex = (mentionIndex - 1 + items.length) % items.length;
        items[mentionIndex].classList.add('selected');
        items[mentionIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (items[mentionIndex].classList.contains('tab-option')) {
           insertTabUrl();
        } else {
           insertMention(items[mentionIndex].textContent);
        }
      }
    }
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) {
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

manualInput.addEventListener('dragover', (e) => {
  e.preventDefault();
  manualInput.style.borderColor = '#3b82f6';
  manualInput.style.backgroundColor = '#eff6ff';
});

manualInput.addEventListener('dragleave', () => {
  manualInput.style.borderColor = '';
  manualInput.style.backgroundColor = '';
});

manualInput.addEventListener('drop', (e) => {
  e.preventDefault();
  manualInput.style.borderColor = '';
  manualInput.style.backgroundColor = '';
  
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    const file = e.dataTransfer.files[0];
    
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = () => {
        const img = document.createElement('img');
        img.src = reader.result;
        manualInput.appendChild(img);
        sendBtn.disabled = false;
      };
      reader.readAsDataURL(file);
      return;
    }
    
    if (file.size > 2 * 1024 * 1024) {
      alert("File is too large! Please select a file under 2MB.");
      return;
    }
    
    const reader = new FileReader();
    reader.onload = () => {
      const text = manualInput.innerText.replace(/[\n\r]+$/, '').replace(/\u00A0/g, ' ');
      let target = null;
      currentOnlineUsers.forEach(u => {
         if (text.includes(`@${u}`)) target = u;
      });
      
      chrome.runtime.sendMessage({ 
        type: 'BROADCAST_AND_SAVE_CLIP', 
        clipData: { type: 'file', fileData: reader.result, fileName: file.name, mimeType: file.type, target: target } 
      });
      
      manualInput.innerHTML = ''; 
    };
    reader.readAsDataURL(file);
  }
});
