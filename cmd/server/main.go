package main

import (
	"context"
	"encoding/json"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/hype-comms/hmm-chat/internal/platform/broadcaster"
	"github.com/hype-comms/hmm-chat/internal/repository/sqlite"
	httpTransport "github.com/hype-comms/hmm-chat/internal/transport/http"
	"github.com/hype-comms/hmm-chat/internal/usecase"
)

const (
	// Graceful shutdown timeout
	shutdownTimeout = 30 * time.Second
)

func main() {
	var addr string
	var dbPath string
	var allowedOrigins string
	var logJSON bool

	flag.StringVar(&addr, "addr", ":8080", "HTTP server address")
	flag.StringVar(&dbPath, "db", "./chat.db", "SQLite database path")
	flag.StringVar(&allowedOrigins, "origins", "", "Comma-separated list of allowed WebSocket origins (empty = use defaults)")
	flag.BoolVar(&logJSON, "log-json", false, "Output logs in JSON format")
	flag.Parse()

	// Configure structured logging
	var handler slog.Handler
	if logJSON {
		handler = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	} else {
		handler = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	}
	logger := slog.New(handler)
	slog.SetDefault(logger)

	slog.Info("HMM Chat Server starting", "addr", addr, "database", dbPath)

	// Initialize database
	slog.Info("Initializing database", "path", dbPath)
	db, err := sqlite.New(dbPath)
	if err != nil {
		slog.Error("Failed to initialize database", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	slog.Info("Database initialized")

	// Initialize repositories
	slog.Info("Initializing repositories")
	channelRepo := sqlite.NewChannelRepository(db)
	messageRepo := sqlite.NewMessageRepository(db)

	// Initialize broadcaster
	slog.Info("Initializing broadcaster")
	msgBroadcaster := broadcaster.New()

	// Initialize use cases
	slog.Info("Initializing use cases")
	channelUC := usecase.NewChannelUseCase(channelRepo)
	messageUC := usecase.NewMessageUseCase(messageRepo, msgBroadcaster, channelRepo)

	// Initialize transport layer
	slog.Info("Initializing HTTP handlers")
	httpHandler := httpTransport.NewHandler(channelUC, messageUC)

	// Parse allowed origins from flag
	var wsOpts []httpTransport.WSServerOption
	if allowedOrigins != "" {
		origins := strings.Split(allowedOrigins, ",")
		for i := range origins {
			origins[i] = strings.TrimSpace(origins[i])
		}
		wsOpts = append(wsOpts, httpTransport.WithAllowedOrigins(origins))
		slog.Info("WebSocket allowed origins configured", "origins", origins)
	} else {
		slog.Info("WebSocket using default allowed origins", "origins", httpTransport.DefaultAllowedOrigins)
	}

	wsServer := httpTransport.NewWSServer(msgBroadcaster, messageUC, channelUC, wsOpts...)

	// Setup HTTP routes
	slog.Info("Setting up routes")
	mux := http.NewServeMux()

	// REST API routes
	mux.HandleFunc("POST /api/channels", httpHandler.CreateChannel)
	mux.HandleFunc("GET /api/channels", httpHandler.ListChannels)

	// WebSocket route
	mux.HandleFunc("/ws", wsServer.HandleWebSocket)

	// Health check
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		slog.Debug("Health check requested")

		// Check database connectivity
		dbStatus := "ok"
		dbStats := db.GetConn().Stats()
		if err := db.GetConn().PingContext(r.Context()); err != nil {
			dbStatus = "error: " + err.Error()
		}

		// Get memory stats
		var memStats runtime.MemStats
		runtime.ReadMemStats(&memStats)

		health := map[string]interface{}{
			"status": "ok",
			"database": map[string]interface{}{
				"status":              dbStatus,
				"open_conns":          dbStats.OpenConnections,
				"in_use":              dbStats.InUse,
				"idle":                dbStats.Idle,
				"wait_count":          dbStats.WaitCount,
				"wait_duration":       dbStats.WaitDuration.String(),
				"max_idle_closed":     dbStats.MaxIdleClosed,
				"max_lifetime_closed": dbStats.MaxLifetimeClosed,
			},
			"memory": map[string]interface{}{
				"alloc_mb":       memStats.Alloc / 1024 / 1024,
				"total_alloc_mb": memStats.TotalAlloc / 1024 / 1024,
				"sys_mb":         memStats.Sys / 1024 / 1024,
				"num_gc":         memStats.NumGC,
			},
			"runtime": map[string]interface{}{
				"goroutines": runtime.NumGoroutine(),
				"go_version": runtime.Version(),
			},
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(health)
	})

	// Start server
	server := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	slog.Info("Server listening", "addr", addr)

	// Run server in a goroutine
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Server error", "error", err)
			os.Exit(1)
		}
	}()

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigChan

	slog.Info("Received shutdown signal", "signal", sig)

	// Create shutdown context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	// Gracefully shutdown the server (waits for active connections to finish)
	if err := server.Shutdown(ctx); err != nil {
		slog.Error("Server shutdown error", "error", err)
		// Force close if graceful shutdown fails
		if err := server.Close(); err != nil {
			slog.Error("Server force close error", "error", err)
		}
	}

	// Close broadcaster to clean up subscriber channels
	slog.Info("Closing broadcaster")
	if err := msgBroadcaster.Close(); err != nil {
		slog.Error("Error closing broadcaster", "error", err)
	}

	slog.Info("Server shutdown complete")
}
