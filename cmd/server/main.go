package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/hype-comms/hmm-chat/internal/platform/broadcaster"
	"github.com/hype-comms/hmm-chat/internal/repository/sqlite"
	httpTransport "github.com/hype-comms/hmm-chat/internal/transport/http"
	"github.com/hype-comms/hmm-chat/internal/usecase"
)

func main() {
	var addr string
	var dbPath string

	flag.StringVar(&addr, "addr", ":8080", "HTTP server address")
	flag.StringVar(&dbPath, "db", "./chat.db", "SQLite database path")
	flag.Parse()

	// Initialize database
	log.Printf("Initializing database at %s...", dbPath)
	db, err := sqlite.New(dbPath)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.Close()

	// Initialize repositories
	channelRepo := sqlite.NewChannelRepository(db)
	messageRepo := sqlite.NewMessageRepository(db)

	// Initialize broadcaster
	msgBroadcaster := broadcaster.New()

	// Initialize use cases
	channelUC := usecase.NewChannelUseCase(channelRepo)
	messageUC := usecase.NewMessageUseCase(messageRepo, msgBroadcaster, channelRepo)

	// Initialize transport layer
	handler := httpTransport.NewHandler(channelUC, messageUC)
	wsServer := httpTransport.NewWSServer(msgBroadcaster, messageUC, channelUC)

	// Setup HTTP routes
	mux := http.NewServeMux()

	// REST API routes
	mux.HandleFunc("POST /api/channels", handler.CreateChannel)
	mux.HandleFunc("GET /api/channels", handler.ListChannels)

	// WebSocket route
	mux.HandleFunc("/ws", wsServer.HandleWebSocket)

	// Health check
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"status":"ok"}`)
	})

	// Start server
	server := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	log.Printf("Starting server on %s", addr)

	// Run server in a goroutine
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Println("Shutting down server...")
	if err := server.Close(); err != nil {
		log.Printf("Server close error: %v", err)
	}
}
