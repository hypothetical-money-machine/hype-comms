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

	// Connect to server
	wsClient, err := tui.NewWebSocketClient(serverAddr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to connect to server: %v\n", err)
		os.Exit(1)
	}
	defer wsClient.Close()

	// Create TUI model
	m := tui.NewModel(wsClient)

	// Run Bubble Tea application
	p := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		log.Printf("Alas, there's been an error: %v", err)
		os.Exit(1)
	}
}
