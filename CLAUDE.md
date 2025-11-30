# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Run Commands

```bash
# Build
make build                    # Build both server and client binaries to bin/

# Run
make run-server              # Build and run server (port :8080)
make run-client              # Build and run client (connects to localhost:8080)
make dev-server              # Run server with 'go run' (for development)
make dev-client              # Run client with 'go run'

# Test
make test                    # Run all tests with race detector and coverage

# Clean
make clean                   # Remove binaries, database files, and coverage output
```

**Server flags**: `-addr` (default `:8080`), `-db` (default `./chat.db`)
**Client flags**: `-addr` (default `localhost:8080`)

## Architecture

This is a WebSocket-based chat application with a TUI client, following Clean Architecture:

```
cmd/
├── server/main.go           # Server entry point, dependency wiring
└── client/main.go           # TUI client entry point

internal/
├── domain/                  # Core entities (Channel, Message) with validation
├── usecase/                 # Business logic orchestration, defines repository interfaces
├── repository/
│   ├── sqlite/              # SQLite implementation with auto-migrations
│   └── inmemory/            # In-memory alternative
├── platform/broadcaster/    # In-memory pub/sub for real-time messaging
└── transport/
    ├── http/                # REST + WebSocket handlers
    └── tui/                 # Bubble Tea terminal client
```

**Layer dependencies flow inward**: transport → usecase → domain. Repositories implement interfaces defined in `usecase/port.go`.

## Key Patterns

**Dependency Injection**: Server wiring in `cmd/server/main.go` shows how repositories and use cases are composed.

**Entity Validation**: Domain types validate themselves (Channel name: 1-100 chars, Message text: 1-4000 chars).

**Non-blocking Broadcasting**: Messages broadcast via goroutines with buffered channels (10-item buffer) to prevent subscriber slowness from blocking senders.

**Logging Prefixes**: Use consistent prefixes for traceability: `[DB]`, `[REPO]`, `[BROADCAST]`, `[USECASE]`, `[HTTP]`, `[WS-CLIENT]`, `[TUI]`.

## WebSocket Protocol

Messages are JSON with structure: `{"type": "...", "payload": {...}, "error": "..."}`

Types: `subscribe`, `send`, `create_channel`, `list_channels`, `history`, `unsubscribe`

## TUI Commands

- `/create <name>` - Create a new channel
- `/list` - List all channels

## Git Operations

Use the `git-ops` agent for all git operations (commits, pushes, pulls, branch management, etc.). This keeps the main context focused on development work.
