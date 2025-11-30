package tui

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	"github.com/hype-comms/hmm-chat/internal/transport/http"
)

const (
	viewChannelList = iota
	viewChat
)

// Model is the main Bubble Tea model for the TUI application
type Model struct {
	// Connection
	wsClient *WebSocketClient

	// State
	view              int
	channels          []http.ChannelResponse
	currentChannelID  string
	currentChannelName string
	messages          map[string][]http.MessageResponse

	// UI Components
	input    textinput.Model
	viewport viewport.Model

	// Error handling
	lastError string

	// Dimensions
	width  int
	height int
}

// NewModel creates a new TUI model
func NewModel(wsClient *WebSocketClient) Model {
	ti := textinput.New()
	ti.Prompt = "> "
	ti.Placeholder = "Type a message..."
	ti.Focus()

	vp := viewport.New(80, 20)
	vp.HighPerformanceRendering = false

	return Model{
		wsClient:  wsClient,
		view:      viewChannelList,
		channels:  []http.ChannelResponse{},
		messages:  make(map[string][]http.MessageResponse),
		input:     ti,
		viewport:  vp,
		lastError: "",
		width:     80,
		height:    24,
	}
}

// Init initializes the model
func (m Model) Init() tea.Cmd {
	log.Println("[TUI] Init called")
	return tea.Batch(
		tickCmd(),
		func() tea.Msg {
			log.Println("[TUI] Requesting channel list...")
			m.wsClient.ListChannels()
			return nil
		},
	)
}

// Update handles messages and updates the model
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q":
			return m, tea.Quit
		case "enter":
			if m.view == viewChannelList {
				text := m.input.Value()
				if strings.HasPrefix(text, "/") {
					m.handleCommand(text)
					m.input.SetValue("")
				} else if len(m.channels) > 0 {
					m.currentChannelID = m.channels[0].ID
					m.currentChannelName = m.channels[0].Name
					m.view = viewChat
					m.input.Focus()
					m.input.SetValue("")
					cmds = append(cmds, func() tea.Msg {
						m.wsClient.Subscribe(m.currentChannelID)
						m.wsClient.GetHistory(m.currentChannelID, 50, 0)
						return nil
					})
				}
			} else if m.view == viewChat {
				text := m.input.Value()
				if strings.HasPrefix(text, "/") {
					m.handleCommand(text)
				} else if text != "" {
					m.wsClient.SendMessage(m.currentChannelID, text)
				}
				m.input.SetValue("")
			}
		case "tab":
			if m.view == viewChat {
				m.view = viewChannelList
				m.input.Blur()
			}
		}

		// Forward key events to textinput
		newInput, cmd := m.input.Update(msg)
		m.input = newInput
		cmds = append(cmds, cmd)

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.viewport.Width = m.width - 2
		m.viewport.Height = m.height - 5

	case wsMessageReceived:
		m.handleWebSocketMessage(msg.msg)

	case wsErrorReceived:
		m.lastError = msg.err.Error()

	case tickMsg:
		// Check for websocket messages without blocking
		m.checkWebSocketMessages()
		cmds = append(cmds, tickCmd())
	}
	return m, tea.Batch(cmds...)
}

// View renders the model
func (m Model) View() string {
	if m.view == viewChannelList {
		view := m.viewChannelListScreen()
		log.Printf("[TUI] View: channel list, %d channels", len(m.channels))
		return view
	}
	log.Printf("[TUI] View: chat screen, channel=%s", m.currentChannelName)
	return m.viewChatScreen()
}

// viewChannelListScreen renders the channel list view
func (m Model) viewChannelListScreen() string {
	var sb strings.Builder

	sb.WriteString("=== Channels ===\n\n")

	if len(m.channels) == 0 {
		sb.WriteString("No channels. Type: /create <name> to create one.\n")
	} else {
		for _, ch := range m.channels {
			sb.WriteString(fmt.Sprintf("[ ] %s\n", ch.Name))
		}
	}

	sb.WriteString("\nCommands:\n")
	sb.WriteString("  /create <name>  - Create a new channel\n")
	sb.WriteString("  /list           - List all channels\n")
	sb.WriteString("  Enter           - Join first channel\n")
	sb.WriteString("  q               - Quit\n")

	if m.lastError != "" {
		sb.WriteString(fmt.Sprintf("\nError: %s\n", m.lastError))
	}

	sb.WriteString("\n")
	sb.WriteString(m.input.View())

	return sb.String()
}

// viewChatScreen renders the chat view
func (m Model) viewChatScreen() string {
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("=== #%s ===\n", m.currentChannelName))
	sb.WriteString("(Press Tab to switch channels, q to quit)\n\n")

	// Display messages
	messages := m.messages[m.currentChannelID]
	if len(messages) == 0 {
		sb.WriteString("No messages yet.\n")
	} else {
		// Show last N messages
		start := len(messages) - 10
		if start < 0 {
			start = 0
		}
		for _, msg := range messages[start:] {
			sb.WriteString(fmt.Sprintf("[%s] %s\n", msg.CreatedAt, msg.Text))
		}
	}

	sb.WriteString("\n")
	sb.WriteString(strings.Repeat("-", m.width))
	sb.WriteString("\n")
	sb.WriteString(m.input.View())

	if m.lastError != "" {
		sb.WriteString(fmt.Sprintf("\nError: %s\n", m.lastError))
	}

	return sb.String()
}

// handleCommand handles slash commands
func (m *Model) handleCommand(cmd string) {
	parts := strings.Fields(cmd)
	if len(parts) == 0 {
		return
	}

	command := parts[0]
	switch command {
	case "/create":
		if len(parts) > 1 {
			channelName := parts[1]
			m.wsClient.CreateChannel(channelName)
		} else {
			m.lastError = "Usage: /create <name>"
		}
	case "/list":
		m.wsClient.ListChannels()
	case "/quit":
		// Handled in KeyMsg
	case "/help":
		m.lastError = "Commands: /create <name>, /list, /quit"
	default:
		m.lastError = fmt.Sprintf("Unknown command: %s", command)
	}
}

// handleWebSocketMessage handles messages from the WebSocket
func (m *Model) handleWebSocketMessage(wsMsg *http.WebSocketMessage) {
	log.Printf("[TUI] Handling WebSocket message: type=%s", wsMsg.Type)
	switch wsMsg.Type {
	case "message":
		var msg http.MessageResponse
		payloadBytes, _ := json.Marshal(wsMsg.Payload)
		if err := json.Unmarshal(payloadBytes, &msg); err != nil {
			log.Printf("[TUI] Failed to unmarshal message: %v", err)
			return
		}
		log.Printf("[TUI] Added message to channel %s", msg.ChannelID)
		m.messages[msg.ChannelID] = append(m.messages[msg.ChannelID], msg)
		m.lastError = ""

	case "subscribed":
		log.Println("[TUI] Subscribed to channel")
		m.lastError = ""

	case "message_sent":
		log.Println("[TUI] Message sent")
		m.lastError = ""

	case "channel_created":
		var ch http.ChannelResponse
		payloadBytes, _ := json.Marshal(wsMsg.Payload)
		if err := json.Unmarshal(payloadBytes, &ch); err != nil {
			log.Printf("[TUI] Failed to unmarshal channel: %v", err)
			return
		}
		log.Printf("[TUI] Created channel: %s", ch.Name)
		m.channels = append(m.channels, ch)
		m.lastError = fmt.Sprintf("Created channel: %s", ch.Name)

	case "channels_list":
		log.Println("[TUI] Received channels_list")
		var payload map[string]interface{}
		payloadBytes, _ := json.Marshal(wsMsg.Payload)
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			log.Printf("[TUI] Failed to unmarshal channels_list: %v", err)
			return
		}

		if channels, ok := payload["channels"].([]interface{}); ok {
			log.Printf("[TUI] Got %d channels", len(channels))
			m.channels = make([]http.ChannelResponse, len(channels))
			for i, ch := range channels {
				chBytes, _ := json.Marshal(ch)
				var chResp http.ChannelResponse
				json.Unmarshal(chBytes, &chResp)
				m.channels[i] = chResp
				log.Printf("[TUI] Channel %d: %s", i, chResp.Name)
			}
			log.Printf("[TUI] Total channels in model: %d", len(m.channels))
		} else {
			log.Printf("[TUI] Failed to parse channels list, payload keys: %v", len(payload))
		}

	case "history":
		var payload map[string]interface{}
		payloadBytes, _ := json.Marshal(wsMsg.Payload)
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			log.Printf("Failed to unmarshal history: %v", err)
			return
		}

		if channelID, ok := payload["channel_id"].(string); ok {
			if messagesData, ok := payload["messages"].([]interface{}); ok {
				m.messages[channelID] = make([]http.MessageResponse, len(messagesData))
				for i, msgData := range messagesData {
					msgBytes, _ := json.Marshal(msgData)
					var msgResp http.MessageResponse
					json.Unmarshal(msgBytes, &msgResp)
					m.messages[channelID][i] = msgResp
				}
			}
		}

	case "error":
		m.lastError = wsMsg.Error
	}
}

// checkWebSocketMessages checks for pending websocket messages without blocking
func (m *Model) checkWebSocketMessages() {
	select {
	case msg := <-m.wsClient.GetRecvChan():
		if msg != nil {
			log.Printf("[TUI] Received WebSocket message: type=%s", msg.Type)
			m.handleWebSocketMessage(msg)
		}
	case err := <-m.wsClient.GetErrorChan():
		if err != nil {
			log.Printf("[TUI] WebSocket error: %v", err)
			m.lastError = err.Error()
		}
	default:
		// No messages waiting, that's fine
	}
}

// tickMsg is a periodic tick message
type tickMsg struct{}

// tickCmd returns a command that ticks periodically
func tickCmd() tea.Cmd {
	return tea.Tick(50*time.Millisecond, func(time.Time) tea.Msg {
		return tickMsg{}
	})
}

// wsMessageReceived is a message from the WebSocket
type wsMessageReceived struct {
	msg *http.WebSocketMessage
}

// wsErrorReceived is an error from the WebSocket
type wsErrorReceived struct {
	err error
}
