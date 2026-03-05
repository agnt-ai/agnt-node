/**
 * @agnt-sdk/client
 *
 * Typed API client for the Agnt platform.
 *
 * @example
 *   import { AgntClient } from '@agnt-sdk/client';
 *
 *   // Management (account-level)
 *   const client = await AgntClient.create();
 *   await client.users.sync({ email: 'alice@example.com' });
 *
 *   // Delegated (user-scoped)
 *   const user = client.as('alice@example.com');
 *   await user.chats.list();
 *   await user.tasks.create({ title: 'Book a flight', assistant: 'travel@agnt.ai' });
 */

export { AgntClient, type AgntClientOptions } from './AgntClient.js';
export { AgntApiError } from './HttpClient.js';

// Resources (useful for typing)
export { ChatsResource } from './resources/ChatsResource.js';
export { TasksResource } from './resources/TasksResource.js';
export { MemoriesResource } from './resources/MemoriesResource.js';
export { ContactsResource } from './resources/ContactsResource.js';
export { IdentifiersResource } from './resources/IdentifiersResource.js';
export { AssistantsResource } from './resources/AssistantsResource.js';
export { UsersResource } from './resources/UsersResource.js';
export { WebhooksResource } from './resources/WebhooksResource.js';

// Types
export type {
  PagedResponse,
  PaginationParams,
  Chat,
  ChatMessage,
  CreateChatBody,
  AddMessageBody,
  ListChatsParams,
  ProcessChatResult,
  Task,
  CreateTaskBody,
  UpdateTaskBody,
  ListTasksParams,
  Memory,
  CreateMemoryBody,
  UpdateMemoryBody,
  ListMemoriesParams,
  Contact,
  CreateContactBody,
  ListContactsParams,
  Identifier,
  CreateIdentifierBody,
  Inbox,
  CreateInboxBody,
  Calendar,
  Assistant,
  CreateAssistantBody,
  UpdateAssistantBody,
  User,
  CreateUserBody,
  UpdateUserBody,
  SyncUserBody,
  ListUsersParams,
  WebhookConfig
} from './types.js';
