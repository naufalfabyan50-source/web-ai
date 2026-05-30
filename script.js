document.addEventListener('DOMContentLoaded', () => {
  // 1. Authentication Check
  const token = localStorage.getItem('auth_token');
  if (!token) {
    window.location.href = 'login.html';
    return;
  }

  // Define DOM Elements
  const chatForm = document.getElementById('chatForm');
  const promptInput = document.getElementById('promptInput');
  const chatWindow = document.getElementById('chatWindow');
  const emptyState = document.getElementById('emptyState');
  const logoutBtn = document.getElementById('logoutBtn');
  const userEmailSpan = document.getElementById('userEmail');
  const sidebar = document.getElementById('sidebar');
  const menuToggle = document.getElementById('menuToggle');
  const newChatBtn = document.getElementById('newChatBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const historySearch = document.getElementById('historySearch');
  const historyContainer = document.getElementById('historyContainer');

  // Context UI Widgets
  const valRepo = document.getElementById('valRepo');
  const valFile = document.getElementById('valFile');
  const valProject = document.getElementById('valProject');

  // Preview Modal Elements
  const previewModal = document.getElementById('previewModal');
  const previewFilePath = document.getElementById('previewFilePath');
  const originalCode = document.getElementById('originalCode');
  const proposedCode = document.getElementById('proposedCode');
  const btnRejectChanges = document.getElementById('btnRejectChanges');
  const btnApplyChanges = document.getElementById('btnApplyChanges');
  const closeModalBtn = document.getElementById('closeModalBtn');

  // State Management
  let currentSessionId = generateUUID();
  let chatMessages = [];
  let isThinking = false;
  
  // Context Memory State
  let contextMemory = {
    activeRepo: null,
    activeFile: null,
    activeFolder: null,
    activeProject: null
  };

  // Buffer state untuk proses Auto Fix / apply edit yang butuh konfirmasi
  let pendingProposal = null;

  // Initialize
  userEmailSpan.textContent = localStorage.getItem('admin_email') || 'admin@admin.com';
  renderHistory();
  updateContextWidgets();

  // Resize Textarea Autogrow
  promptInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
  });

  // Toggle Sidebar
  menuToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

  // Logout Click
  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('admin_email');
    window.location.href = 'login.html';
  });

  // Start New Chat
  newChatBtn.addEventListener('click', () => {
    currentSessionId = generateUUID();
    chatMessages = [];
    chatWindow.innerHTML = '';
    chatWindow.appendChild(emptyState);
    emptyState.classList.remove('hidden');
    renderHistory();
  });

  // Submit Prompt Handler
  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const messageContent = promptInput.value.trim();
    if (!messageContent || isThinking) return;

    // Reset input
    promptInput.value = '';
    promptInput.style.height = 'auto';

    // Hide empty state
    emptyState.classList.add('hidden');

    // Add user message
    appendMessage('user', messageContent);
    chatMessages.push({ role: 'user', content: messageContent });

    // Save session title if this is the first message
    const currentHistory = window.ChatHistoryManager.getChats();
    const existing = currentHistory.find(c => c.id === currentSessionId);
    let title = messageContent.substring(0, 30) + (messageContent.length > 30 ? '...' : '');
    if (existing) {
      title = existing.title;
    }

    window.ChatHistoryManager.saveChatSession(currentSessionId, title, chatMessages);
    renderHistory();

    // Show AI Thinking indicator
    const typingElement = appendTypingIndicator();
    isThinking = true;

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          action: 'chat',
          message: messageContent,
          context: contextMemory,
          history: chatMessages.slice(0, -1) // Kirim history sebelum pesan terakhir
        })
      });

      const data = await response.json();
      removeTypingIndicator(typingElement);

      if (response.ok && data.success) {
        // Output tool logs if any run took place
        if (data.toolRuns && data.toolRuns.length > 0) {
          data.toolRuns.forEach(run => {
            appendToolLog(run.name, run.status, run.details);
          });
        }

        // Add assistant text
        appendMessage('assistant', data.responseText);
        chatMessages.push({ role: 'assistant', content: data.responseText });

        // Update context memory
        if (data.updatedContext) {
          contextMemory = { ...contextMemory, ...data.updatedContext };
          updateContextWidgets();
        }

        // Save session update
        window.ChatHistoryManager.saveChatSession(currentSessionId, title, chatMessages);
        renderHistory();

        // Handle auto-fix / edit preview confirmation modal
        if (data.previewChanges) {
          pendingProposal = data.previewChanges;
          openPreviewModal(data.previewChanges);
        }

      } else {
        appendMessage('assistant', `⚠️ Terjadi kesalahan: ${data.error || 'Server error'}`);
      }
    } catch (err) {
      removeTypingIndicator(typingElement);
      appendMessage('assistant', '⚠️ Gagal menghubungi server atau jaringan terputus.');
    } finally {
      isThinking = false;
    }
  });

  // Modal Buttons
  btnRejectChanges.addEventListener('click', () => {
    closePreviewModal();
    appendMessage('assistant', "❌ Perubahan kode dibatalkan oleh pengguna.");
    chatMessages.push({ role: 'assistant', content: "Perubahan kode dibatalkan oleh pengguna." });
    window.ChatHistoryManager.saveChatSession(currentSessionId, "Batal modifikasi kode", chatMessages);
  });

  btnApplyChanges.addEventListener('click', async () => {
    if (!pendingProposal) return;
    closePreviewModal();

    // Show indicator
    const typingElement = appendTypingIndicator();
    appendMessage('assistant', "⚙️ Meng-apply perubahan, melakukan commit, dan men-deploy kembali...");

    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          action: 'apply_changes',
          proposal: pendingProposal,
          context: contextMemory
        })
      });

      const data = await response.json();
      removeTypingIndicator(typingElement);

      if (response.ok && data.success) {
        appendMessage('assistant', `✅ **Perubahan berhasil diterapkan!**\n\n- **File:** \`${pendingProposal.path}\`\n- **Commit:** "${pendingProposal.commitMessage}"\n- **Status Vercel Deployment:** ${data.vercelStatus || 'Dalam Proses'}\n\nProyek sedang dibangun ulang.`);
        chatMessages.push({ 
          role: 'assistant', 
          content: `Perubahan berhasil diterapkan pada ${pendingProposal.path}. Deployment baru sedang berjalan.` 
        });
        
        // Simpan context terbaru dari respons
        if (data.updatedContext) {
          contextMemory = { ...contextMemory, ...data.updatedContext };
          updateContextWidgets();
        }
      } else {
        appendMessage('assistant', `❌ **Gagal menerapkan perubahan:** ${data.error || 'Unknown Error'}`);
      }
    } catch (err) {
      removeTypingIndicator(typingElement);
      appendMessage('assistant', '❌ **Terjadi kesalahan koneksi saat menerapkan perubahan.**');
    } finally {
      pendingProposal = null;
      window.ChatHistoryManager.saveChatSession(currentSessionId, "Apply Perubahan Kode", chatMessages);
      renderHistory();
    }
  });

  // CLOSE MODAL LOGICS
  closeModalBtn.addEventListener('click', () => { closePreviewModal(); });
  window.addEventListener('click', (e) => { if (e.target === previewModal) closePreviewModal(); });

  function closePreviewModal() {
    previewModal.classList.add('hidden');
  }

  function openPreviewModal(previewData) {
    previewFilePath.textContent = previewData.path || 'unknown_file';
    originalCode.textContent = previewData.originalCode || '// Tidak ada kode original (file baru)';
    proposedCode.textContent = previewData.proposedCode || '// Tidak ada perubahan yang diajukan';
    previewModal.classList.remove('hidden');
  }

  // CHAT UI UTILITIES
  function appendMessage(role, text) {
    const chatRow = document.createElement('div');
    chatRow.classList.add('chat-row', role === 'user' ? 'user-row' : 'agent-row');

    const bubble = document.createElement('div');
    bubble.classList.add('bubble');
    
    // Parse Markdown basic formats (bold, code blocks)
    bubble.innerHTML = parseMarkdown(text);

    chatRow.appendChild(bubble);
    chatWindow.appendChild(chatRow);
    scrollToBottom();
  }

  function appendTypingIndicator() {
    const chatRow = document.createElement('div');
    chatRow.classList.add('chat-row', 'agent-row');

    const bubble = document.createElement('div');
    bubble.classList.add('bubble');

    const indicator = document.createElement('div');
    indicator.classList.add('typing-indicator');
    indicator.innerHTML = '<span></span><span></span><span></span>';

    bubble.appendChild(indicator);
    chatRow.appendChild(bubble);
    chatWindow.appendChild(chatRow);
    scrollToBottom();
    return chatRow;
  }

  function removeTypingIndicator(element) {
    if (element && element.parentNode) {
      element.parentNode.removeChild(element);
    }
  }

  function appendToolLog(toolName, status, details) {
    const logDiv = document.createElement('div');
    logDiv.classList.add('tool-run-log', status === 'success' ? 'success' : 'error');
    
    const icon = status === 'success' ? '⚙️' : '⚠️';
    logDiv.innerHTML = `<span>${icon} <strong>Tool:</strong> ${toolName} | <em>${details}</em></span>`;
    
    chatWindow.appendChild(logDiv);
    scrollToBottom();
  }

  function updateContextWidgets() {
    valRepo.textContent = contextMemory.activeRepo || 'None';
    valFile.textContent = contextMemory.activeFile || 'None';
    valProject.textContent = contextMemory.activeProject || 'None';

    valRepo.classList.toggle('italic', !contextMemory.activeRepo);
    valFile.classList.toggle('italic', !contextMemory.activeFile);
    valProject.classList.toggle('italic', !contextMemory.activeProject);
  }

  function scrollToBottom() {
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }

  // Markdown Parser Sederhana
  function parseMarkdown(text) {
    let html = text;
    // Blok Kode (Pre / Code)
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    // Kode Inline
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Tebal (Bold)
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Bullet Points
    html = html.replace(/^\s*-\s+(.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>)/g, '<ul>$1<\/ul>');
    // Ganti newline ganda dengan paragraf
    html = html.replace(/\n\n/g, '</p><p>');
    // Ganti newline tunggal dengan breakline
    html = html.replace(/\n/g, '<br>');
    
    return `<p>${html}</p>`;
  }

  // RENDERING HISTORY LIST
  function renderHistory() {
    historyContainer.innerHTML = '';
    const query = historySearch.value.trim();
    const grouped = window.ChatHistoryManager.groupByDate(
      query ? window.ChatHistoryManager.searchChats(query) : null
    );

    const labels = {
      today: 'Hari Ini',
      yesterday: 'Kemarin',
      last7Days: '7 Hari Terakhir',
      older: 'Terdahulu'
    };

    Object.keys(grouped).forEach(key => {
      const groupChats = grouped[key];
      if (groupChats.length === 0) return;

      const titleDiv = document.createElement('div');
      titleDiv.classList.add('history-group-title');
      titleDiv.textContent = labels[key];
      historyContainer.appendChild(titleDiv);

      groupChats.forEach(chat => {
        const item = document.createElement('div');
        item.classList.add('history-item');
        if (chat.id === currentSessionId) {
          item.classList.add('active');
        }

        const titleText = document.createElement('span');
        titleText.classList.add('chat-title');
        titleText.textContent = chat.title;
        item.appendChild(titleText);

        // Delete Button
        const delBtn = document.createElement('button');
        delBtn.classList.add('btn-delete-item');
        delBtn.innerHTML = '🗑️';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.ChatHistoryManager.deleteChatSession(chat.id);
          if (chat.id === currentSessionId) {
            newChatBtn.click();
          } else {
            renderHistory();
          }
        });
        item.appendChild(delBtn);

        // Click to load chat session
        item.addEventListener('click', () => {
          loadChatSession(chat.id);
        });

        historyContainer.appendChild(item);
      });
    });
  }

  function loadChatSession(id) {
    const chats = window.ChatHistoryManager.getChats();
    const chat = chats.find(c => c.id === id);
    if (!chat) return;

    currentSessionId = id;
    chatMessages = chat.messages;
    chatWindow.innerHTML = '';
    emptyState.classList.add('hidden');

    chatMessages.forEach(msg => {
      appendMessage(msg.role, msg.content);
    });

    // Cari context terakhir yang terekam
    const lastAssistantMsg = [...chatMessages].reverse().find(m => m.role === 'assistant');
    updateContextWidgets();
    renderHistory();
  }

  // Search History Event Listener
  historySearch.addEventListener('input', () => {
    renderHistory();
  });

  // Clear History
  clearHistoryBtn.addEventListener('click', () => {
    if (confirm('Apakah Anda yakin ingin menghapus semua riwayat chat?')) {
      window.ChatHistoryManager.clearAll();
      newChatBtn.click();
    }
  });

  // Global Quick Prompt Handler
  window.setQuickPrompt = function(promptText) {
    promptInput.value = promptText;
    promptInput.style.height = 'auto';
    promptInput.style.height = (promptInput.scrollHeight) + 'px';
    promptInput.focus();
  };

  function generateUUID() {
    return 'chat-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
});
