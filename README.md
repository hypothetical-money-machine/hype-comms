# HMM Chat

A real-time chat system built with Go, WebSockets, and a terminal UI client.

## Features

- **API Server**: WebSocket-based chat server with SQLite persistence
- **TUI Client**: Interactive terminal user interface built with Bubble Tea
- **Channels**: Create and manage chat channels
- **Real-time Broadcasting**: Messages broadcast instantly to all connected clients
- **Message History**: Retrieve historical messages from any channel
- **Clean Architecture**: Domain-driven design with clear separation of concerns

## Quick Start

### Prerequisites

- Go 1.21+
- SQLite3 (included in build)

### Build

```bash
make build
```

Or build individually:

```bash
go build -o bin/server ./cmd/server
go build -o bin/client ./cmd/client
```

### Run Server

```bash
# Using make
make run-server

# Or directly
./bin/server

# Or with go run (development)
make dev-server
```

The server will start on `localhost:8080` and create a `chat.db` file for message storage.

### Run Client

In a separate terminal:

```bash
# Using make
make run-client

# Or directly
./bin/client

# Or with go run (development)
make dev-client
```

## Usage

### Terminal UI Client

The TUI client provides an interactive interface for chatting.

**Main Screen (Channel List)**:
- `Enter` - Join the first channel
- `/create <name>` - Create a new channel
- `/list` - Refresh channel list
- `q` - Quit

**Chat Screen**:
- Type message and press `Enter` to send
- `Tab` - Switch back to channel list
- `q` - Quit

### WebSocket Protocol

The server accepts WebSocket connections at `/ws`. Messages are JSON with the following format:

#### Client → Server

```json
{
  "type": "message",
  "payload": {
    "channel_id": "channel-uuid",
    "text": "Hello!"
  }
}
```

Message types:
- `message` - Send a message to a channel
- `subscribe` - Subscribe to a channel (get real-time updates)
- `create_channel` - Create a new channel
- `list_channels` - Get all channels
- `history` - Get message history for a channel
- `unsubscribe` - Unsubscribe from a channel

#### Server → Client

```json
{
  "type": "message",
  "payload": {
    "id": "message-uuid",
    "channel_id": "channel-uuid",
    "text": "Hello!",
    "created_at": "2025-11-29T12:34:56Z"
  }
}
```

Response types:
- `message` - New message received
- `channels_list` - List of available channels
- `history` - Message history for a channel
- `channel_created` - New channel created
- `subscribed` - Successfully subscribed to a channel
- `error` - Error message

## Architecture

The project follows clean architecture principles:

```
internal/
├── domain/              # Core business logic (entities, validation, errors)
├── usecase/             # Application logic (channels, messages, broadcasting)
├── repository/          # Data access layer (SQLite, in-memory)
├── platform/            # Infrastructure (broadcaster, config, logger)
└── transport/           # Interface adapters (HTTP, WebSocket, TUI)
```

### Key Components

- **Domain**: `Channel` and `Message` entities with validation rules
- **UseCases**: `ChannelUseCase` and `MessageUseCase` orchestrate business logic
- **Repositories**: Implement channel and message persistence
- **Broadcaster**: In-memory pub/sub for real-time message distribution
- **WebSocket Server**: Handles client connections and message protocol
- **TUI Client**: Bubble Tea application for terminal interaction

## Database

The server uses SQLite with automatic migrations. The database file (`chat.db`) is created automatically on first run.

**Tables**:
- `channels` - Stores channel metadata
- `messages` - Stores messages with timestamps
- `schema_versions` - Tracks applied migrations

## Development

### Run Tests

```bash
make test
```

### Clean Up

```bash
make clean
```

Removes binaries and database files.

## Notes

- No user authentication - all messages are anonymous
- Single server instance (in-memory broadcaster)
- WebSocket connections are text-based JSON messages
- Message history is paginated (default 50 messages, max 100)

## Future Enhancements

- User authentication and identification
- Private messages
- Message editing and deletion
- User presence and typing indicators
- Persistent user settings
- Multi-server support with Redis broadcaster
- Rate limiting
- Message reactions
