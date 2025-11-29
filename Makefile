.PHONY: build run-server run-client test dev-server dev-client clean help

help:
	@echo "HMM Chat - Go Server + TUI Client"
	@echo ""
	@echo "Available targets:"
	@echo "  build       - Build server and client binaries"
	@echo "  run-server  - Run the server (default: localhost:8080)"
	@echo "  run-client  - Run the CLI client (default: localhost:8080)"
	@echo "  dev-server  - Run server with 'go run' for development"
	@echo "  dev-client  - Run client with 'go run' for development"
	@echo "  test        - Run all tests"
	@echo "  clean       - Remove built binaries and database files"

build:
	@mkdir -p bin
	@echo "Building server..."
	@go build -o bin/server ./cmd/server
	@echo "Building client..."
	@go build -o bin/client ./cmd/client
	@echo "Done!"

run-server: build
	./bin/server

run-client: build
	./bin/client

dev-server:
	@go run ./cmd/server

dev-client:
	@go run ./cmd/client

test:
	@go test -v -race -coverprofile=coverage.out ./...

clean:
	@rm -rf bin/
	@rm -f *.db
	@rm -f coverage.out
	@echo "Cleaned up build artifacts and database files"
