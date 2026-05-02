import type { AgentId, ChannelId } from './types.js';

/** Router: agent_id ↔ chat_ids bidirectional mapping. */
export class Router {
  private agentToChats = new Map<AgentId, ChannelId[]>();
  private chatToAgent = new Map<ChannelId, AgentId>();

  register(agentId: AgentId, chatIds: ChannelId[]): void {
    // Deduplicate within the call itself
    const unique = [...new Set(chatIds)];

    // P0: before writing new mappings, evict any chatId already held by another agent
    for (const chatId of unique) {
      const owner = this.chatToAgent.get(chatId);
      if (owner !== undefined && owner !== agentId) {
        // Remove from the other agent's array
        const otherChats = this.agentToChats.get(owner);
        if (otherChats) {
          const filtered = otherChats.filter((c) => c !== chatId);
          if (filtered.length === 0) {
            this.agentToChats.delete(owner);
          } else {
            this.agentToChats.set(owner, filtered);
          }
        }
        this.chatToAgent.delete(chatId);
      }
    }

    // Remove old reverse mappings for this agent
    const old = this.agentToChats.get(agentId);
    if (old) {
      for (const chatId of old) {
        this.chatToAgent.delete(chatId);
      }
    }
    this.agentToChats.set(agentId, unique);
    for (const chatId of unique) {
      this.chatToAgent.set(chatId, agentId);
    }
  }

  resolve(chatId: ChannelId): AgentId | undefined {
    return this.chatToAgent.get(chatId);
  }

  chats(agentId: AgentId): ChannelId[] {
    return this.agentToChats.get(agentId) ?? [];
  }

  get size(): number {
    return this.chatToAgent.size;
  }
}
