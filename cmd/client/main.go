package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/hype-comms/hmm-chat/internal/transport/tui"
)

func main() {
	var serverAddr string

	flag.StringVar(&serverAddr, "addr", "localhost:8080", "Server address")
	flag.Parse()

	// Redirect logs to file so TUI isn't disrupted
	logFile, err := os.OpenFile("client.log", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to open log file: %v\n", err)
		os.Exit(1)
	}
	defer logFile.Close()
	log.SetOutput(logFile)

	log.Println("=== HMM Chat Client Starting ===")
	log.Printf("Server address: %s", serverAddr)

	// Connect to server
	log.Printf("[CLIENT] Connecting to server at %s...", serverAddr)
	wsClient, err := tui.NewWebSocketClient(serverAddr)
	if err != nil {
		log.Printf("[CLIENT] Failed to connect to server: %v", err)
		fmt.Fprintf(os.Stderr, "Failed to connect to server: %v\n", err)
		os.Exit(1)
	}
	log.Println("[CLIENT] Connected to server successfully")
	defer wsClient.Close()

	// Create TUI model
	log.Println("[CLIENT] Creating TUI model...")
	m := tui.NewModel(wsClient)
	log.Println("[CLIENT] TUI model created")

	// Run Bubble Tea application
	log.Println("[CLIENT] Starting Bubble Tea program...")
	p := tea.NewProgram(m, tea.WithAltScreen())
	log.Println("[CLIENT] Running program...")
	if _, err := p.Run(); err != nil {
		log.Printf("[CLIENT] Alas, there's been an error: %v", err)
		os.Exit(1)
	}
	log.Println("[CLIENT] Program finished")
}
