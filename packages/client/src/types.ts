// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

export interface PagedResponse<T> {
  ok: boolean;
  page: number;
  perPage: number;
  total: number;
  items: T[];
}

export interface PaginationParams {
  page?: number;
  perPage?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chats
// ─────────────────────────────────────────────────────────────────────────────

export interface Chat {
  id: string;
  title?: string;
  status: 'active' | 'archived';
  messageCount: number;
  assistant?: { id: string; name: string; email: string };
  metadata?: Record<string, any>;
  lastMessageAt?: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  platform?: string;
  files?: any[];
  metadata?: Record<string, any>;
  timestamp?: string;
  createdAt?: string;
}

export interface CreateChatBody {
  assistantId: string;
  title?: string;
  metadata?: Record<string, any>;
}

export interface AddMessageBody {
  content: string;
  role?: 'user' | 'assistant';
  files?: any[];
  platform?: string;
  metadata?: Record<string, any>;
}

export interface ListChatsParams extends PaginationParams {
  status?: 'active' | 'archived';
  assistantId?: string;
  [key: string]: any; // metadata.* filters
}

export interface ProcessChatResult {
  ok: boolean;
  message?: ChatMessage;
  taskIds?: string[];
  suppressed?: boolean;
  ignored?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskParty {
  id: string;
  type: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface Task {
  id: string;
  account?: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'on_hold';
  type?: string;
  order?: number;
  owner?: TaskParty;
  assistant?: TaskParty | string;
  assignees?: TaskParty[];
  followers?: TaskParty[];
  skills?: string[];
  hasWriteActions?: boolean;
  plan?: any[];
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskBody {
  title: string;
  assistant: string;
  description?: string;
  type?: string;
  status?: string;
  assignedUsers?: string[];
  followers?: string[];
  skills?: string[];
}

export interface UpdateTaskBody {
  title?: string;
  description?: string;
  status?: string;
  type?: string;
  assistant?: string;
  assignedUsers?: string[];
  followers?: string[];
  skills?: string[];
  input?: any;
  scheduledFor?: string;
}

export interface ListTasksParams extends PaginationParams {
  status?: string;
  mine?: boolean;
  type?: string;
  search?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Memories
// ─────────────────────────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  account?: string;
  user?: string;
  type?: string;
  content: string;
  tags?: string[];
  source?: string;
  isActive?: boolean;
  isExpired?: boolean;
  startDate?: string;
  endDate?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateMemoryBody {
  content: string;
  type?: string;
  tags?: string[];
  startDate?: string;
  endDate?: string;
  metadata?: Record<string, any>;
}

export interface UpdateMemoryBody {
  content?: string;
  type?: string;
  tags?: string[];
  startDate?: string;
  endDate?: string;
  metadata?: Record<string, any>;
}

export interface ListMemoriesParams extends PaginationParams {
  type?: string;
  tags?: string;
  search?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contacts
// ─────────────────────────────────────────────────────────────────────────────

export interface Contact {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  emails?: string[];
  phone?: string;
  company?: string;
  status?: string;
  consumer?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateContactBody {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  company?: string;
  metadata?: Record<string, any>;
}

export interface BulkImportResult {
  success: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: any[];
}

export interface ListContactsParams extends PaginationParams {
  company?: string;
  email?: string;
  search?: string;
  status?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identifiers
// ─────────────────────────────────────────────────────────────────────────────

export interface Identifier {
  id: string;
  type: string;
  value: string;
  isPrimary?: boolean;
  userId?: string;
  platforms?: Record<string, any>;
  createdAt: string;
}

export interface CreateIdentifierBody {
  type: string;
  value: string;
}

export interface Inbox {
  id: string;
  platform: 'google' | 'azure';
  email: string;
  referenceId: string;
  lastSyncedAt?: string;
  syncError?: boolean;
  createdAt: string;
}

export interface CreateInboxBody {
  platform: 'google' | 'azure';
  email: string;
  referenceId: string;
}

export interface Calendar {
  id: string;
  name: string;
  platform: 'google' | 'microsoft';
  identifierId?: string;
  isPrimary?: boolean;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assistants
// ─────────────────────────────────────────────────────────────────────────────

export interface Assistant {
  id: string;
  account?: string;
  user?: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  signature?: string;
  personality?: string;
  writingStyle?: string;
  description?: string;
  status: 'active' | 'inactive';
  isSystemTemplate?: boolean;
  skills?: string[];
  tags?: string[];
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateAssistantBody {
  name: string;
  email?: string;
  avatarUrl?: string;
  signature?: string;
  personality?: string;
  writingStyle?: string;
  description?: string;
  skills?: string[];
  tags?: string[];
  metadata?: Record<string, any>;
}

export interface UpdateAssistantBody {
  name?: string;
  email?: string;
  avatarUrl?: string;
  signature?: string;
  personality?: string;
  writingStyle?: string;
  description?: string;
  status?: 'active' | 'inactive';
  skills?: string[];
  tags?: string[];
  metadata?: Record<string, any>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  account?: string;
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
  timezone?: string;
  locale?: string;
  assistant?: string;
  status: 'active' | 'inactive';
  externalId?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateUserBody {
  email: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
  metadata?: Record<string, any>;
}

export interface SyncUserBody {
  email: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
}

export interface UpdateUserBody {
  firstName?: string;
  lastName?: string;
  status?: 'active' | 'inactive';
  metadata?: Record<string, any>;
}

export interface ListUsersParams extends PaginationParams {
  status?: string;
  email?: string;
  externalId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhooks
// ─────────────────────────────────────────────────────────────────────────────

export interface WebhookConfig {
  enabled: boolean;
  url: string;
  events: string[];
  retryEnabled?: boolean;
  maxRetries?: number;
}
