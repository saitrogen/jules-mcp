# Quickstart

The Jules REST API lets you programmatically access Jules's capabilities to automate and enhance your software development lifecycle. You can use the API to create custom workflows, automate tasks like bug fixing and code reviews, and embed Jules's intelligence directly into the tools you use every day, such as Slack, Linear, and GitHub.

<ApiNote>
The Jules REST API is in an alpha release, which means it is experimental. Be aware that we may change specifications, API keys, and definitions as we work toward stabilization. In the future, we plan to maintain at least one stable and one experimental version.
</ApiNote>

## Authentication

To get started with the Jules REST API, you'll need an API key.

### Generate Your API Key

In the Jules web app, go to the **[Settings](https://jules.google.com/settings#api)** page to create a new API key. You can have at most 3 API keys at a time.

![Jules REST API Key creation interface](../../../../../public/jules-api-key-settings.png)

### Use Your API Key

To authenticate your requests, pass the API key in the `X-Goog-Api-Key` header of your API calls.

<ApiNote type="caution">
Keep your API keys secure. Don't share them or embed them in public code. For your protection, any API keys found to be publicly exposed will be [automatically disabled](https://cloud.google.com/resource-manager/docs/organization-policy/restricting-service-accounts#disable-exposed-keys) to prevent abuse.
</ApiNote>

## API concepts

The Jules REST API is built around a few core resources. Understanding these will help you use the API effectively.

- **Source** — An input source for the agent (e.g., a GitHub repository). Before using a source using the API, you must first [install the Jules GitHub app](/docs/) through the Jules web app.
- **Session** — A continuous unit of work within a specific context, similar to a chat session. A session is initiated with a prompt and a source.
- **Activity** — A single unit of work within a Session. A Session contains multiple activities from both the user and the agent, such as generating a plan, sending a message, or updating progress.

## Your first API call

We'll walk through creating your first session with the Jules REST API using curl.

1. ### List your available sources

   First, you need to find the name of the source you want to work with (e.g., your GitHub repo). This command will return a list of all sources you have connected to Jules.

   ```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sources

```

   The response will look something like this:

   ```json
   {
     "sources": [
       {
         "name": "sources/github/bobalover/boba",
         "id": "github/bobalover/boba",
         "githubRepo": {
           "owner": "bobalover",
           "repo": "boba"
         }
       }
     ],
     "nextPageToken": "github/bobalover/boba-web"
   }
   ```

2. ### Create a new session

   Now, create a new session. You'll need the source name from the previous step. This request tells Jules to create a boba app in the specified repository.

   ```bash
curl 'https://jules.googleapis.com/v1alpha/sessions' \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -d '{
    "prompt": "Create a boba app!",
    "sourceContext": {
      "source": "sources/github/bobalover/boba",
      "githubRepoContext": {
        "startingBranch": "main"
      }
    },
    "automationMode": "AUTO_CREATE_PR",
    "title": "Boba App"
  }'
```

The `automationMode` field is optional. By default, no PR will be automatically created.

   The immediate response will look something like this:

   ```json
   {
     "name": "sessions/31415926535897932384",
     "id": "31415926535897932384",
     "title": "Boba App",
     "sourceContext": {
       "source": "sources/github/bobalover/boba",
       "githubRepoContext": {
         "startingBranch": "main"
       }
     },
     "prompt": "Create a boba app!"
   }
   ```

   You can poll the latest session information using `GetSession` or `ListSessions`. For example, if a PR was automatically created, you can see the PR in the session output:

   ```json
   {
     "name": "sessions/31415926535897932384",
     "id": "31415926535897932384",
     "title": "Boba App",
     "sourceContext": {
       "source": "sources/github/bobalover/boba",
       "githubRepoContext": {
         "startingBranch": "main"
       }
     },
     "prompt": "Create a boba app!",
     "outputs": [
       {
         "pullRequest": {
           "url": "https://github.com/bobalover/boba/pull/35",
           "title": "Create a boba app",
           "description": "This change adds the initial implementation of a boba app."
         }
       }
     ]
   }
   ```

   By default, sessions created through the API will have their plans automatically approved. If you want to create a session that requires explicit plan approval, set the `requirePlanApproval` field to `true`.

3. ### List sessions

   You can list your sessions as follows:

   ```bash
curl 'https://jules.googleapis.com/v1alpha/sessions?pageSize=5' \
  -H "x-goog-api-key: $JULES_API_KEY"

```

4. ### Approve a plan

   If your session requires explicit plan approval, you can approve the latest plan as follows:

   ```bash
curl 'https://jules.googleapis.com/v1alpha/sessions/SESSION_ID:approvePlan' \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: $JULES_API_KEY"
```

5. ### Interact with the agent

   To list activities in a session:

   ```bash
curl 'https://jules.googleapis.com/v1alpha/sessions/SESSION_ID/activities?pageSize=30' \
  -H "x-goog-api-key: $JULES_API_KEY"

```

   To send a message to the agent:

   ```bash
curl 'https://jules.googleapis.com/v1alpha/sessions/SESSION_ID:sendMessage' \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -d '{
    "prompt": "Can you make the app corgi themed?"
  }'
```

The response will be empty because the agent will send its response in the next activity. To see the agent's response, list the activities again.

## Next steps

# API Reference

The Jules REST API allows you to programmatically create and manage coding sessions, monitor progress, and retrieve results. This reference documents all available endpoints, request/response formats, and data types.

## Base URL

All API requests should be made to:

```
https://jules.googleapis.com/v1alpha
```

## Authentication

The Jules REST API uses API keys for authentication. Get your API key from [jules.google.com/settings](https://jules.google.com/settings).

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sessions
```

## Endpoints

## Common Patterns

### Pagination

List endpoints support pagination using `pageSize` and `pageToken` parameters:

```bash
# First page
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sessions?pageSize=10"

# Next page (using token from previous response)
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sessions?pageSize=10&pageToken=NEXT_PAGE_TOKEN"
```

### Resource Names

Resources use hierarchical names following Google API conventions:

- Sessions: `sessions/{sessionId}`
- Activities: `sessions/{sessionId}/activities/{activityId}`
- Sources: `sources/{sourceId}`

### Error Handling

The API returns standard HTTP status codes:

| Status | Description |
|--------|-------------|
| `200` | Success |
| `400` | Bad request - invalid parameters |
| `401` | Unauthorized - invalid or missing token |
| `403` | Forbidden - insufficient permissions |
| `404` | Not found - resource doesn't exist |
| `429` | Rate limited - too many requests |
| `500` | Server error |

Error responses include a JSON body with details:

```json
{
  "error": {
    "code": 400,
    "message": "Invalid session ID format",
    "status": "INVALID_ARGUMENT"
  }
}
```
# API Reference

The Jules REST API allows you to programmatically create and manage coding sessions, monitor progress, and retrieve results. This reference documents all available endpoints, request/response formats, and data types.

## Base URL

All API requests should be made to:

```
https://jules.googleapis.com/v1alpha
```

## Authentication

The Jules REST API uses API keys for authentication. Get your API key from [jules.google.com/settings](https://jules.google.com/settings).

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sessions
```

## Endpoints

## Common Patterns

### Pagination

List endpoints support pagination using `pageSize` and `pageToken` parameters:

```bash
# First page
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sessions?pageSize=10"

# Next page (using token from previous response)
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sessions?pageSize=10&pageToken=NEXT_PAGE_TOKEN"
```

### Resource Names

Resources use hierarchical names following Google API conventions:

- Sessions: `sessions/{sessionId}`
- Activities: `sessions/{sessionId}/activities/{activityId}`
- Sources: `sources/{sourceId}`

### Error Handling

The API returns standard HTTP status codes:

| Status | Description |
|--------|-------------|
| `200` | Success |
| `400` | Bad request - invalid parameters |
| `401` | Unauthorized - invalid or missing token |
| `403` | Forbidden - insufficient permissions |
| `404` | Not found - resource doesn't exist |
| `429` | Rate limited - too many requests |
| `500` | Server error |

Error responses include a JSON body with details:

```json
{
  "error": {
    "code": 400,
    "message": "Invalid session ID format",
    "status": "INVALID_ARGUMENT"
  }
}
```
# Sessions

Sessions are the core resource in the Jules REST API. A session represents a unit of work where Jules executes a coding task on your repository.

## Create a Session

<ApiEndpoint method="POST" path="/v1alpha/sessions" description="Creates a new session to start a coding task.">

### Request Body

### Example Request

```bash
curl -X POST \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Add comprehensive unit tests for the authentication module",
    "title": "Add auth tests",
    "sourceContext": {
      "source": "sources/github-myorg-myrepo",
      "githubRepoContext": {
        "startingBranch": "main"
      }
    },
    "requirePlanApproval": true
  }' \
  https://jules.googleapis.com/v1alpha/sessions
```

### Response

Returns the created [Session](/docs/api/reference/types#session) object:

```json
{
  "name": "sessions/1234567",
  "id": "abc123",
  "prompt": "Add comprehensive unit tests for the authentication module",
  "title": "Add auth tests",
  "state": "QUEUED",
  "url": "https://jules.google.com/session/abc123",
  "createTime": "2024-01-15T10:30:00Z",
  "updateTime": "2024-01-15T10:30:00Z"
}
```

</ApiEndpoint>

## List Sessions

<ApiEndpoint method="GET" path="/v1alpha/sessions" description="Lists all sessions for the authenticated user.">

### Query Parameters

### Example Request

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sessions?pageSize=10"
```

### Response

```json
{
  "sessions": [
    {
      "name": "sessions/1234567",
      "id": "abc123",
      "title": "Add auth tests",
      "state": "COMPLETED",
      "createTime": "2024-01-15T10:30:00Z",
      "updateTime": "2024-01-15T11:45:00Z"
    }
  ],
  "nextPageToken": "eyJvZmZzZXQiOjEwfQ=="
}
```

</ApiEndpoint>

## Get a Session

<ApiEndpoint method="GET" path="/v1alpha/sessions/{sessionId}" description="Retrieves a single session by ID.">

### Path Parameters

### Example Request

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sessions/1234567
```

### Response

Returns the full [Session](/docs/api/reference/types#session) object including outputs if the session has completed:

```json
{
  "name": "sessions/1234567",
  "id": "abc123",
  "prompt": "Add comprehensive unit tests for the authentication module",
  "title": "Add auth tests",
  "state": "COMPLETED",
  "url": "https://jules.google.com/session/abc123",
  "createTime": "2024-01-15T10:30:00Z",
  "updateTime": "2024-01-15T11:45:00Z",
  "outputs": [
    {
      "pullRequest": {
        "url": "https://github.com/myorg/myrepo/pull/42",
        "title": "Add auth tests",
        "description": "Added unit tests for authentication module"
      }
    }
  ]
}
```

</ApiEndpoint>

## Delete a Session

<ApiEndpoint method="DELETE" path="/v1alpha/sessions/{sessionId}" description="Deletes a session.">

### Path Parameters

### Example Request

```bash
curl -X DELETE \
  -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sessions/1234567
```

### Response

Returns an empty response on success.

</ApiEndpoint>

## Send a Message

<ApiEndpoint method="POST" path="/v1alpha/sessions/{sessionId}:sendMessage" description="Sends a message from the user to an active session.">

Use this endpoint to provide feedback, answer questions, or give additional instructions to Jules during an active session.

### Path Parameters

### Request Body

### Example Request

```bash
curl -X POST \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Please also add integration tests for the login flow"
  }' \
  https://jules.googleapis.com/v1alpha/sessions/1234567:sendMessage
```

### Response

Returns an empty [SendMessageResponse](/docs/api/reference/types#sendmessageresponse) on success.

</ApiEndpoint>

## Approve a Plan

<ApiEndpoint method="POST" path="/v1alpha/sessions/{sessionId}:approvePlan" description="Approves a pending plan in a session.">

<ApiNote>
  This endpoint is only needed when `requirePlanApproval` was set to `true` when creating the session.
</ApiNote>

### Path Parameters

### Example Request

```bash
curl -X POST \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://jules.googleapis.com/v1alpha/sessions/1234567:approvePlan
```

### Response

Returns an empty [ApprovePlanResponse](/docs/api/reference/types#approveplanresponse) on success.

</ApiEndpoint>

## Session States

Sessions progress through the following states:

| State | Description |
|-------|-------------|
| `QUEUED` | Session is waiting to be processed |
| `PLANNING` | Jules is analyzing the task and creating a plan |
| `AWAITING_PLAN_APPROVAL` | Plan is ready and waiting for user approval |
| `AWAITING_USER_FEEDBACK` | Jules needs additional input from the user |
| `IN_PROGRESS` | Jules is actively working on the task |
| `PAUSED` | Session is paused |
| `COMPLETED` | Task completed successfully |
| `FAILED` | Task failed to complete |

# Sessions

Sessions are the core resource in the Jules REST API. A session represents a unit of work where Jules executes a coding task on your repository.

## Create a Session

<ApiEndpoint method="POST" path="/v1alpha/sessions" description="Creates a new session to start a coding task.">

### Request Body

### Example Request

```bash
curl -X POST \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Add comprehensive unit tests for the authentication module",
    "title": "Add auth tests",
    "sourceContext": {
      "source": "sources/github-myorg-myrepo",
      "githubRepoContext": {
        "startingBranch": "main"
      }
    },
    "requirePlanApproval": true
  }' \
  https://jules.googleapis.com/v1alpha/sessions
```

### Response

Returns the created [Session](/docs/api/reference/types#session) object:

```json
{
  "name": "sessions/1234567",
  "id": "abc123",
  "prompt": "Add comprehensive unit tests for the authentication module",
  "title": "Add auth tests",
  "state": "QUEUED",
  "url": "https://jules.google.com/session/abc123",
  "createTime": "2024-01-15T10:30:00Z",
  "updateTime": "2024-01-15T10:30:00Z"
}
```

</ApiEndpoint>

## List Sessions

<ApiEndpoint method="GET" path="/v1alpha/sessions" description="Lists all sessions for the authenticated user.">

### Query Parameters

### Example Request

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sessions?pageSize=10"
```

### Response

```json
{
  "sessions": [
    {
      "name": "sessions/1234567",
      "id": "abc123",
      "title": "Add auth tests",
      "state": "COMPLETED",
      "createTime": "2024-01-15T10:30:00Z",
      "updateTime": "2024-01-15T11:45:00Z"
    }
  ],
  "nextPageToken": "eyJvZmZzZXQiOjEwfQ=="
}
```

</ApiEndpoint>

## Get a Session

<ApiEndpoint method="GET" path="/v1alpha/sessions/{sessionId}" description="Retrieves a single session by ID.">

### Path Parameters

### Example Request

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sessions/1234567
```

### Response

Returns the full [Session](/docs/api/reference/types#session) object including outputs if the session has completed:

```json
{
  "name": "sessions/1234567",
  "id": "abc123",
  "prompt": "Add comprehensive unit tests for the authentication module",
  "title": "Add auth tests",
  "state": "COMPLETED",
  "url": "https://jules.google.com/session/abc123",
  "createTime": "2024-01-15T10:30:00Z",
  "updateTime": "2024-01-15T11:45:00Z",
  "outputs": [
    {
      "pullRequest": {
        "url": "https://github.com/myorg/myrepo/pull/42",
        "title": "Add auth tests",
        "description": "Added unit tests for authentication module"
      }
    }
  ]
}
```

</ApiEndpoint>

## Delete a Session

<ApiEndpoint method="DELETE" path="/v1alpha/sessions/{sessionId}" description="Deletes a session.">

### Path Parameters

### Example Request

```bash
curl -X DELETE \
  -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sessions/1234567
```

### Response

Returns an empty response on success.

</ApiEndpoint>

## Send a Message

<ApiEndpoint method="POST" path="/v1alpha/sessions/{sessionId}:sendMessage" description="Sends a message from the user to an active session.">

Use this endpoint to provide feedback, answer questions, or give additional instructions to Jules during an active session.

### Path Parameters

### Request Body

### Example Request

```bash
curl -X POST \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Please also add integration tests for the login flow"
  }' \
  https://jules.googleapis.com/v1alpha/sessions/1234567:sendMessage
```

### Response

Returns an empty [SendMessageResponse](/docs/api/reference/types#sendmessageresponse) on success.

</ApiEndpoint>

## Approve a Plan

<ApiEndpoint method="POST" path="/v1alpha/sessions/{sessionId}:approvePlan" description="Approves a pending plan in a session.">

<ApiNote>
  This endpoint is only needed when `requirePlanApproval` was set to `true` when creating the session.
</ApiNote>

### Path Parameters

### Example Request

```bash
curl -X POST \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://jules.googleapis.com/v1alpha/sessions/1234567:approvePlan
```

### Response

Returns an empty [ApprovePlanResponse](/docs/api/reference/types#approveplanresponse) on success.

</ApiEndpoint>

## Session States

Sessions progress through the following states:

| State | Description |
|-------|-------------|
| `QUEUED` | Session is waiting to be processed |
| `PLANNING` | Jules is analyzing the task and creating a plan |
| `AWAITING_PLAN_APPROVAL` | Plan is ready and waiting for user approval |
| `AWAITING_USER_FEEDBACK` | Jules needs additional input from the user |
| `IN_PROGRESS` | Jules is actively working on the task |
| `PAUSED` | Session is paused |
| `COMPLETED` | Task completed successfully |
| `FAILED` | Task failed to complete |

# Sources

Sources represent repositories connected to Jules. Currently, Jules supports GitHub repositories. Use the Sources API to list available repositories and get details about specific sources.

<ApiNote>
  Sources are created when you connect a GitHub repository to Jules through the web interface. The API currently only supports reading sources, not creating them.
</ApiNote>

## List Sources

<ApiEndpoint method="GET" path="/v1alpha/sources" description="Lists all sources (repositories) connected to your account.">

### Query Parameters

### Example Request

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sources?pageSize=10"
```

### Response

```json
{
  "sources": [
    {
      "name": "sources/github-myorg-myrepo",
      "id": "github-myorg-myrepo",
      "githubRepo": {
        "owner": "myorg",
        "repo": "myrepo",
        "isPrivate": false,
        "defaultBranch": {
          "displayName": "main"
        },
        "branches": [
          { "displayName": "main" },
          { "displayName": "develop" },
          { "displayName": "feature/auth" }
        ]
      }
    },
    {
      "name": "sources/github-myorg-another-repo",
      "id": "github-myorg-another-repo",
      "githubRepo": {
        "owner": "myorg",
        "repo": "another-repo",
        "isPrivate": true,
        "defaultBranch": {
          "displayName": "main"
        },
        "branches": [
          { "displayName": "main" }
        ]
      }
    }
  ],
  "nextPageToken": "eyJvZmZzZXQiOjEwfQ=="
}
```

### Filtering

Use the `filter` parameter to retrieve specific sources:

```bash
# Get a specific source
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sources?filter=name%3Dsources%2Fgithub-myorg-myrepo"

# Get multiple sources
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sources?filter=name%3Dsources%2Fsource1%20OR%20name%3Dsources%2Fsource2"
```

</ApiEndpoint>

## Get a Source

<ApiEndpoint method="GET" path="/v1alpha/sources/{sourceId}" description="Retrieves a single source by ID.">

### Path Parameters

### Example Request

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sources/github-myorg-myrepo
```

### Response

Returns the full [Source](/docs/api/reference/types#source) object:

```json
{
  "name": "sources/github-myorg-myrepo",
  "id": "github-myorg-myrepo",
  "githubRepo": {
    "owner": "myorg",
    "repo": "myrepo",
    "isPrivate": false,
    "defaultBranch": {
      "displayName": "main"
    },
    "branches": [
      { "displayName": "main" },
      { "displayName": "develop" },
      { "displayName": "feature/auth" },
      { "displayName": "feature/tests" }
    ]
  }
}
```

</ApiEndpoint>

## Using Sources with Sessions

When creating a session, reference a source using its resource name in the `sourceContext`:

```bash
curl -X POST \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Add unit tests for the auth module",
    "sourceContext": {
      "source": "sources/github-myorg-myrepo",
      "githubRepoContext": {
        "startingBranch": "develop"
      }
    }
  }' \
  https://jules.googleapis.com/v1alpha/sessions
```

<ApiNote>
  Use the List Sources endpoint to discover available source names, then use the Get Source endpoint to see available branches before creating a session.
</ApiNote>

# Sources

Sources represent repositories connected to Jules. Currently, Jules supports GitHub repositories. Use the Sources API to list available repositories and get details about specific sources.

<ApiNote>
  Sources are created when you connect a GitHub repository to Jules through the web interface. The API currently only supports reading sources, not creating them.
</ApiNote>

## List Sources

<ApiEndpoint method="GET" path="/v1alpha/sources" description="Lists all sources (repositories) connected to your account.">

### Query Parameters

### Example Request

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sources?pageSize=10"
```

### Response

```json
{
  "sources": [
    {
      "name": "sources/github-myorg-myrepo",
      "id": "github-myorg-myrepo",
      "githubRepo": {
        "owner": "myorg",
        "repo": "myrepo",
        "isPrivate": false,
        "defaultBranch": {
          "displayName": "main"
        },
        "branches": [
          { "displayName": "main" },
          { "displayName": "develop" },
          { "displayName": "feature/auth" }
        ]
      }
    },
    {
      "name": "sources/github-myorg-another-repo",
      "id": "github-myorg-another-repo",
      "githubRepo": {
        "owner": "myorg",
        "repo": "another-repo",
        "isPrivate": true,
        "defaultBranch": {
          "displayName": "main"
        },
        "branches": [
          { "displayName": "main" }
        ]
      }
    }
  ],
  "nextPageToken": "eyJvZmZzZXQiOjEwfQ=="
}
```

### Filtering

Use the `filter` parameter to retrieve specific sources:

```bash
# Get a specific source
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sources?filter=name%3Dsources%2Fgithub-myorg-myrepo"

# Get multiple sources
curl -H "x-goog-api-key: $JULES_API_KEY" \
  "https://jules.googleapis.com/v1alpha/sources?filter=name%3Dsources%2Fsource1%20OR%20name%3Dsources%2Fsource2"
```

</ApiEndpoint>

## Get a Source

<ApiEndpoint method="GET" path="/v1alpha/sources/{sourceId}" description="Retrieves a single source by ID.">

### Path Parameters

### Example Request

```bash
curl -H "x-goog-api-key: $JULES_API_KEY" \
  https://jules.googleapis.com/v1alpha/sources/github-myorg-myrepo
```

### Response

Returns the full [Source](/docs/api/reference/types#source) object:

```json
{
  "name": "sources/github-myorg-myrepo",
  "id": "github-myorg-myrepo",
  "githubRepo": {
    "owner": "myorg",
    "repo": "myrepo",
    "isPrivate": false,
    "defaultBranch": {
      "displayName": "main"
    },
    "branches": [
      { "displayName": "main" },
      { "displayName": "develop" },
      { "displayName": "feature/auth" },
      { "displayName": "feature/tests" }
    ]
  }
}
```

</ApiEndpoint>

## Using Sources with Sessions

When creating a session, reference a source using its resource name in the `sourceContext`:

```bash
curl -X POST \
  -H "x-goog-api-key: $JULES_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Add unit tests for the auth module",
    "sourceContext": {
      "source": "sources/github-myorg-myrepo",
      "githubRepoContext": {
        "startingBranch": "develop"
      }
    }
  }' \
  https://jules.googleapis.com/v1alpha/sessions
```

<ApiNote>
  Use the List Sources endpoint to discover available source names, then use the Get Source endpoint to see available branches before creating a session.
</ApiNote>