const ChatHistoryManager = {
  getChats() {
    return JSON.parse(localStorage.getItem('ai_agent_chats')) || [];
  },

  saveChatSession(id, title, messages) {
    let chats = this.getChats();
    const index = chats.findIndex(chat => chat.id === id);
    if (index !== -1) {
      chats[index].messages = messages;
      chats[index].updatedAt = new Date().toISOString();
    } else {
      chats.push({
        id,
        title,
        messages,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    localStorage.setItem('ai_agent_chats', JSON.stringify(chats));
  },

  deleteChatSession(id) {
    let chats = this.getChats();
    chats = chats.filter(chat => chat.id !== id);
    localStorage.setItem('ai_agent_chats', JSON.stringify(chats));
  },

  clearAll() {
    localStorage.removeItem('ai_agent_chats');
  },

  groupByDate(filteredChats = null) {
    const chats = (filteredChats || this.getChats()).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const groups = {
      today: [],
      yesterday: [],
      last7Days: [],
      older: []
    };
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    chats.forEach(chat => {
      const chatDate = new Date(chat.updatedAt);
      const compareDate = new Date(chatDate.getFullYear(), chatDate.getMonth(), chatDate.getDate());

      if (compareDate.getTime() === today.getTime()) {
        groups.today.push(chat);
      } else if (compareDate.getTime() === yesterday.getTime()) {
        groups.yesterday.push(chat);
      } else if (compareDate.getTime() >= sevenDaysAgo.getTime()) {
        groups.last7Days.push(chat);
      } else {
        groups.older.push(chat);
      }
    });

    return groups;
  },

  searchChats(query) {
    const lowercaseQuery = query.toLowerCase();
    const allChats = this.getChats();
    if (!query) return allChats;

    return allChats.filter(chat => {
      const matchTitle = chat.title.toLowerCase().includes(lowercaseQuery);
      const matchContent = chat.messages.some(msg => msg.content.toLowerCase().includes(lowercaseQuery));
      return matchTitle || matchContent;
    });
  }
};

window.ChatHistoryManager = ChatHistoryManager;