# Agnt API — Real Response Shapes

Discovered through live integration testing against `localhost:3006`.
Key for `kid: agnt-1772748299206-2f7438ff`, API at `http://localhost:3006`.

---

## Auth

- **Management client** (`AgntClient.create()`): JWT has no `email` claim.
- **Delegated client** (`client.as(email, opts)`): JWT includes `email` in payload.
- Token TTL: 5 minutes; cached per `kid:email` in module-level `Map`.
- Header: `Authorization: Bearer <RS256 JWT>`

---

## Users

### `GET /users` (paged)
```json
{
  "ok": true,
  "page": 1,
  "perPage": 20,
  "total": 1,
  "users": [
    {
      "id": "...",
      "account": "...",
      "email": "user@example.com",
      "name": "First Last",
      "firstName": "First",
      "lastName": "Last",
      "avatarUrl": null,
      "timezone": null,
      "locale": null,
      "assistant": "...",
      "status": "active",
      "metadata": {},
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

### `GET /users/:id`
```json
{ "user": { ...user, "identifiers": [...], "contacts": [...] } }
```
Note: `get` includes nested `identifiers` and `contacts` arrays.

### `POST /users/sync`
```json
{ "user": { ...user } }
```
Note: If a user with that email already exists, the backend may return an error. Use list+find to check first.

### `PUT /users/:id`
```json
{ "user": { ...user } }
```

---

## Identifiers

**Primary email identifier is auto-provisioned when a user is first synced/created.** You cannot create it manually — it will return "already exists".

Secondary identifiers (e.g., additional email addresses) can be created explicitly.

### `GET /identifiers` (paged)
```json
{
  "ok": true,
  "page": 1,
  "perPage": 20,
  "total": 1,
  "identifiers": [
    {
      "id": "...",
      "type": "email",
      "value": "user@example.com",
      "isPrimary": true,
      "userId": "...",
      "platforms": {},
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

### `GET /identifiers/:id`
```json
{ "identifier": { ...identifier, "platforms": {} } }
```

### `POST /identifiers`
```json
{ "identifier": { ...identifier } }
```

### `DELETE /identifiers/:id`
Returns `200 { ok: true }`.

### Preferences

#### `GET /identifiers/:id/preferences`
Returns the full preferences document with top-level section keys:
```json
{
  "preferences": {
    "scheduling": {
      "defaults": { "virtual": { "duration": 30 } }
    },
    "reminders": {},
    "followups": {},
    "travel": {}
  }
}
```

#### `PUT /identifiers/:id/preferences/:section`
Body **must** be wrapped in `{ "preferences": { ... } }`:
```json
{ "preferences": { "defaults": { "virtual": { "duration": 45 } } } }
```
Returns: `{ "preferences": { ...updated section } }`

Note: There is no per-section GET endpoint — use the list endpoint and extract the section client-side.

---

## Assistants

Assistants are account-level AI personas. None are auto-provisioned — you must create at least one before creating chats or tasks.

### `GET /assistants`
```json
{
  "assistants": [
    {
      "id": "...",
      "account": "...",
      "user": null,
      "name": "assistant-slug",
      "email": "assistant@agnt.ai",
      "avatarUrl": null,
      "signature": null,
      "personality": null,
      "writingStyle": null,
      "status": "active",
      "isSystemTemplate": false,
      "tags": [],
      "metadata": {},
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

### `POST /assistants`
Body:
```json
{ "name": "my-assistant", "email": "assistant@agnt.ai" }
```
Returns: `{ "assistant": { ...assistant } }`

### `GET /assistants/:id`
Returns: `{ "assistant": { ...assistant } }`

---

## Contacts

### `POST /contacts`
Body: `{ "email": "...", "name": "..." }`
Returns:
```json
{
  "contact": {
    "id": "...",
    "name": "Test Contact",
    "email": "test@example.com",
    "emails": ["test@example.com"],
    "status": "active",
    "consumer": null,
    "metadata": {},
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### `POST /contacts/bulk-import`
Body: `{ "contacts": [{ "email": "...", "name": "..." }, ...] }`
Returns:
```json
{
  "ok": true,
  "bulkImport": {
    "success": true,
    "total": 2,
    "created": 2,
    "updated": 0,
    "skipped": 0,
    "errors": []
  }
}
```

---

## Memories

### `POST /memories`
Body: `{ "content": "..." }`
Returns:
```json
{
  "memory": {
    "id": "...",
    "account": "...",
    "user": "...",
    "content": "Prefers aisle seats on flights",
    "tags": [],
    "source": "manual",
    "isActive": true,
    "isExpired": false,
    "metadata": {},
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

## Chats

**Requires** an `assistantId` (not `assistant`) in the create body.

### `POST /chats`
Body: `{ "title": "...", "assistantId": "..." }`
Returns: `{ "chat": { "id": "...", "title": "...", ... } }`

### `GET /chats` (paged)
```json
{ "ok": true, "page": 1, "perPage": 20, "total": 1, "chats": [...] }
```

### `POST /chats/:id/messages`
Body: `{ "role": "user", "content": "..." }`
Returns: `{ "message": { "id": "...", "role": "user", "content": "...", ... } }`

### `GET /chats/:id/messages` (paged)
```json
{ "ok": true, "page": 1, "perPage": 20, "total": 1, "messages": [...] }
```

### `DELETE /chats/:id/messages`
Clears all messages. Returns `200 { ok: true }`.

---

## Tasks

### `POST /tasks`
Body: `{ "title": "...", "assistant": "<assistantId>" }`
Returns:
```json
{
  "task": {
    "id": "...",
    "account": "...",
    "title": "SDK test task",
    "status": "pending",
    "type": "general",
    "order": 0,
    "owner": {
      "id": "...",
      "type": "user",
      "email": "user@example.com",
      "firstName": "First",
      "lastName": "Last"
    },
    "assistant": {
      "id": "...",
      "type": "assistant",
      "email": "assistant@agnt.ai"
    },
    "assignees": [],
    "followers": [],
    "skills": [],
    "hasWriteActions": false,
    "plan": [],
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### `POST /tasks/:id/feedback`
Body: `{ "status": "like" | "dislike" | null }`
To remove feedback: `{ "status": null }`.

---

## Pagination

All paged endpoints follow:
```json
{ "ok": true, "page": 1, "perPage": 20, "total": N, "<resource>s": [...] }
```
where `<resource>` is the snake_case singular: `users`, `contacts`, `memories`, `chats`, `messages`, `tasks`, `identifiers`.
