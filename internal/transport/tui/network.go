package tui

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hype-comms/hmm-chat/internal/transport/http"
)

// WebSocketClient handles WebSocket communication with the server
type WebSocketClient struct {
	conn      *websocket.Conn
	send      chan interface{}
	recv      chan *http.WebSocketMessage
	errors    chan error
	closeDone chan struct{}
}

// NewWebSocketClient creates a new WebSocket client
func NewWebSocketClient(serverAddr string) (*WebSocketClient, error) {
	wsURL := url.URL{Scheme: "ws", Host: serverAddr, Path: "/ws"}
	log.Printf("Connecting to %s", wsURL.String())

	// Set a timeout on the dialer
	dialer := websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
	}

	conn, _, err := dialer.Dial(wsURL.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to server: %w", err)
	}

	client := &WebSocketClient{
		conn:      conn,
		send:      make(chan interface{}, 10),
		recv:      make(chan *http.WebSocketMessage, 10),
		errors:    make(chan error, 10),
		closeDone: make(chan struct{}),
	}

	// Start read and write goroutines
	go client.readLoop()
	go client.writeLoop()

	return client, nil
}

// readLoop reads messages from the server
func (c *WebSocketClient) readLoop() {
	defer close(c.recv)
	for {
		var wsMsg http.WebSocketMessage
		if err := c.conn.ReadJSON(&wsMsg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket read error: %v", err)
				select {
				case c.errors <- err:
				case <-c.closeDone:
				}
			}
			return
		}

		select {
		case c.recv <- &wsMsg:
		case <-c.closeDone:
			return
		}
	}
}

// writeLoop writes messages to the server
func (c *WebSocketClient) writeLoop() {
	for msg := range c.send {
		if err := c.conn.WriteJSON(msg); err != nil {
			log.Printf("WebSocket write error: %v", err)
			select {
			case c.errors <- err:
			case <-c.closeDone:
			}
			return
		}
	}
}

// Subscribe subscribes to a channel
func (c *WebSocketClient) Subscribe(channelID string) error {
	msg := http.WebSocketMessage{
		Type: "subscribe",
		Payload: json.RawMessage(mustMarshal(http.SubscribePayload{
			ChannelID: channelID,
		})),
	}

	c.send <- msg
	return nil
}

// SendMessage sends a message to a channel
func (c *WebSocketClient) SendMessage(channelID, text string) error {
	msg := http.WebSocketMessage{
		Type: "send",
		Payload: json.RawMessage(mustMarshal(http.SendMessagePayload{
			ChannelID: channelID,
			Text:      text,
		})),
	}

	c.send <- msg
	return nil
}

// CreateChannel creates a new channel
func (c *WebSocketClient) CreateChannel(name string) error {
	msg := http.WebSocketMessage{
		Type: "create_channel",
		Payload: json.RawMessage(mustMarshal(http.CreateChannelPayload{
			Name: name,
		})),
	}

	c.send <- msg
	return nil
}

// ListChannels requests the list of channels
func (c *WebSocketClient) ListChannels() error {
	msg := http.WebSocketMessage{
		Type: "list_channels",
	}

	c.send <- msg
	return nil
}

// GetHistory requests message history for a channel
func (c *WebSocketClient) GetHistory(channelID string, limit, offset int) error {
	if limit == 0 {
		limit = 50
	}

	msg := http.WebSocketMessage{
		Type: "history",
		Payload: json.RawMessage(mustMarshal(http.GetHistoryPayload{
			ChannelID: channelID,
			Limit:     limit,
			Offset:    offset,
		})),
	}

	c.send <- msg
	return nil
}

// Close closes the WebSocket connection
func (c *WebSocketClient) Close() error {
	close(c.closeDone)
	close(c.send)
	return c.conn.Close()
}

// GetRecvChan returns the receive channel
func (c *WebSocketClient) GetRecvChan() <-chan *http.WebSocketMessage {
	return c.recv
}

// GetErrorChan returns the error channel
func (c *WebSocketClient) GetErrorChan() <-chan error {
	return c.errors
}

// mustMarshal marshals a value to JSON, panicking on error
func mustMarshal(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
