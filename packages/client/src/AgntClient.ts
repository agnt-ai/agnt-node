/**
 * AgntClient — typed API client for the Agnt platform.
 *
 * Two modes, same class:
 *
 *   Management (account-level):
 *     const client = await AgntClient.create();
 *     await client.users.sync({ email: 'alice@example.com' });
 *     await client.assistants.list();
 *
 *   Delegated (user-scoped):
 *     const user = client.as('alice@example.com');
 *     await user.chats.list();
 *     await user.tasks.create({ title: 'Book a flight', assistant: 'travel@agnt.ai' });
 *     await user.memories.create({ content: 'Prefers aisle seats' });
 */

import { loadConfig } from '@agnt-sdk/config';
import type { AgntConfig } from '@agnt-sdk/config';
import { signJwt } from './auth.js';
import { HttpClient } from './HttpClient.js';
import { ChatsResource } from './resources/ChatsResource.js';
import { TasksResource } from './resources/TasksResource.js';
import { MemoriesResource } from './resources/MemoriesResource.js';
import { ContactsResource } from './resources/ContactsResource.js';
import { IdentifiersResource } from './resources/IdentifiersResource.js';
import { AssistantsResource } from './resources/AssistantsResource.js';
import { UsersResource } from './resources/UsersResource.js';
import { WebhooksResource } from './resources/WebhooksResource.js';

export interface AgntClientOptions {
  /** Delegate API calls to this user (puts email in JWT payload) */
  email?: string;
  /** Optional — passed into JWT for user auto-provisioning */
  firstName?: string;
  /** Optional — passed into JWT for user auto-provisioning */
  lastName?: string;
  /** Override config file (useful for programmatic setup) */
  config?: AgntConfig;
}

export class AgntClient {
  // ── Delegated APIs (user-scoped) ───────────────────────────────────────────
  readonly chats: ChatsResource;
  readonly tasks: TasksResource;
  readonly memories: MemoriesResource;
  readonly contacts: ContactsResource;
  readonly identifiers: IdentifiersResource;

  // ── Management APIs (account-level) ───────────────────────────────────────
  readonly assistants: AssistantsResource;
  readonly users: UsersResource;
  readonly webhooks: WebhooksResource;

  private readonly config: AgntConfig;
  private readonly email?: string;
  private readonly firstName?: string;
  private readonly lastName?: string;

  private constructor(config: AgntConfig, options?: Pick<AgntClientOptions, 'email' | 'firstName' | 'lastName'>) {
    this.config = config;
    this.email = options?.email;
    this.firstName = options?.firstName;
    this.lastName = options?.lastName;

    if (!config.privateKey) throw new Error('[AgntClient] config.privateKey is required');
    if (!config.kid) throw new Error('[AgntClient] config.kid is required');

    const http = new HttpClient(config.apiUrl, () =>
      signJwt({
        privateKey: config.privateKey!,
        kid: config.kid!,
        email: this.email,
        firstName: this.firstName,
        lastName: this.lastName
      })
    );

    this.chats = new ChatsResource(http);
    this.tasks = new TasksResource(http);
    this.memories = new MemoriesResource(http);
    this.contacts = new ContactsResource(http);
    this.identifiers = new IdentifiersResource(http);
    this.assistants = new AssistantsResource(http);
    this.users = new UsersResource(http);
    this.webhooks = new WebhooksResource(http);
  }

  /**
   * Create a management-level client (account-wide JWT, no email).
   * Loads config from agnt.config.js if not provided.
   */
  static async create(options?: AgntClientOptions): Promise<AgntClient> {
    const config = options?.config ?? await loadConfig();
    if (!config) throw new Error('[AgntClient] No agnt.config.js found. Run: agnt init');
    return new AgntClient(config, options);
  }

  /**
   * Return a new client scoped to a specific user (delegated JWT).
   * Reuses the same config — no reload needed.
   *
   * @example
   *   const user = client.as('alice@example.com');
   *   await user.chats.list();
   */
  as(email: string, names?: { firstName?: string; lastName?: string }): AgntClient {
    return new AgntClient(this.config, {
      email,
      firstName: names?.firstName,
      lastName: names?.lastName
    });
  }

  /** The email this client is delegated to (undefined = management/account-level) */
  get delegatedEmail(): string | undefined {
    return this.email;
  }
}
