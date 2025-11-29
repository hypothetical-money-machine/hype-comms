package http

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/hype-comms/hmm-chat/internal/domain"
	"github.com/hype-comms/hmm-chat/internal/usecase"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for now
	},
}

// WSServer handles WebSocket connections
type WSServer struct {
	broadcaster usecase.MessageBroadcaster
	messageUC  *usecase.MessageUseCase
	channelUC  *usecase.ChannelUseCase
}

// NewWSServer creates a new WebSocket server
func NewWSServer(b usecase.MessageBroadcaster, msgUC *usecase.MessageUseCase, chUC *usecase.ChannelUseCase) *WSServer {
	return &WSServer{
		broadcaster: b,
		messageUC:   msgUC,
		channelUC:   chUC,
	}
}

// HandleWebSocket upgrades HTTP connection to WebSocket and handles it
func (s *WSServer) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close()

	clientAddr := conn.RemoteAddr().String()
	log.Printf("WebSocket client connected: %s", clientAddr)

	// Handle messages from this client
	for {
		var wsMsg WebSocketMessage
		if err := conn.ReadJSON(&wsMsg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket client %s disconnected: %v", clientAddr, err)
			}
			return
		}

		log.Printf("WebSocket message from %s: type=%s", clientAddr, wsMsg.Type)

		// Handle different message types
		switch wsMsg.Type {
		case "subscribe":
			s.handleSubscribe(conn, wsMsg)
		case "send":
			s.handleSend(conn, wsMsg)
		case "create_channel":
			s.handleCreateChannel(conn, wsMsg)
		case "list_channels":
			s.handleListChannels(conn)
		case "history":
			s.handleHistory(conn, wsMsg)
		default:
			s.sendError(conn, "Unknown message type")
		}
	}
}

// handleSubscribe subscribes the client to a channel
func (s *WSServer) handleSubscribe(conn *websocket.Conn, wsMsg WebSocketMessage) {
	var payload SubscribePayload
	payloadBytes, _ := json.Marshal(wsMsg.Payload)
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		s.sendError(conn, "Invalid subscribe payload")
		return
	}

	channelID := domain.ChannelID(payload.ChannelID)
	ctx := context.Background()

	// Verify channel exists
	if _, err := s.channelUC.GetChannel(ctx, channelID); err != nil {
		s.sendError(conn, "Channel not found")
		return
	}

	// Subscribe to channel
	msgChan, err := s.broadcaster.Subscribe(ctx, channelID)
	if err != nil {
		s.sendError(conn, "Failed to subscribe")
		return
	}

	// Send acknowledgement
	s.sendMessage(conn, "subscribed", map[string]string{"channel_id": string(channelID)})

	// Listen for messages from the channel
	for msg := range msgChan {
		s.sendMessage(conn, "message", DomainMessageToResponse(msg))
	}
}

// handleSend sends a message to a channel
func (s *WSServer) handleSend(conn *websocket.Conn, wsMsg WebSocketMessage) {
	var payload SendMessagePayload
	payloadBytes, _ := json.Marshal(wsMsg.Payload)
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		s.sendError(conn, "Invalid send payload")
		return
	}

	channelID := domain.ChannelID(payload.ChannelID)
	ctx := context.Background()

	msg, err := s.messageUC.SendMessage(ctx, channelID, payload.Text)
	if err != nil {
		s.sendError(conn, err.Error())
		return
	}

	// Send acknowledgement
	s.sendMessage(conn, "message_sent", DomainMessageToResponse(msg))
}

// handleCreateChannel creates a new channel
func (s *WSServer) handleCreateChannel(conn *websocket.Conn, wsMsg WebSocketMessage) {
	var payload CreateChannelPayload
	payloadBytes, _ := json.Marshal(wsMsg.Payload)
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		s.sendError(conn, "Invalid create_channel payload")
		return
	}

	ctx := context.Background()
	ch, err := s.channelUC.CreateChannel(ctx, payload.Name)
	if err != nil {
		s.sendError(conn, err.Error())
		return
	}

	s.sendMessage(conn, "channel_created", DomainChannelToResponse(ch))
}

// handleListChannels returns all channels
func (s *WSServer) handleListChannels(conn *websocket.Conn) {
	ctx := context.Background()
	channels, err := s.channelUC.ListChannels(ctx)
	if err != nil {
		s.sendError(conn, "Failed to list channels")
		return
	}

	responses := make([]ChannelResponse, len(channels))
	for i, ch := range channels {
		responses[i] = DomainChannelToResponse(ch)
	}

	s.sendMessage(conn, "channels_list", map[string]interface{}{"channels": responses})
}

// handleHistory sends message history for a channel
func (s *WSServer) handleHistory(conn *websocket.Conn, wsMsg WebSocketMessage) {
	var payload GetHistoryPayload
	payloadBytes, _ := json.Marshal(wsMsg.Payload)
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		s.sendError(conn, "Invalid history payload")
		return
	}

	channelID := domain.ChannelID(payload.ChannelID)
	limit := payload.Limit
	if limit == 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	ctx := context.Background()
	messages, err := s.messageUC.GetMessages(ctx, channelID, limit, payload.Offset)
	if err != nil {
		s.sendError(conn, "Failed to get history")
		return
	}

	responses := make([]MessageResponse, len(messages))
	for i, msg := range messages {
		responses[i] = DomainMessageToResponse(msg)
	}

	s.sendMessage(conn, "history", map[string]interface{}{
		"channel_id": payload.ChannelID,
		"messages":   responses,
	})
}

// sendMessage sends a WebSocket message to the client
func (s *WSServer) sendMessage(conn *websocket.Conn, msgType string, payload interface{}) {
	payloadBytes, _ := json.Marshal(payload)
	wsMsg := WebSocketMessage{
		Type:    msgType,
		Payload: json.RawMessage(payloadBytes),
	}

	if err := conn.WriteJSON(wsMsg); err != nil {
		log.Printf("Failed to send message type %s: %v", msgType, err)
		return
	}
	log.Printf("Sent message to %s: type=%s", conn.RemoteAddr().String(), msgType)
}

// sendError sends an error message to the client
func (s *WSServer) sendError(conn *websocket.Conn, message string) {
	wsMsg := WebSocketMessage{
		Type:  "error",
		Error: message,
	}

	if err := conn.WriteJSON(wsMsg); err != nil {
		log.Printf("Failed to send error message: %v", err)
		return
	}
	log.Printf("Sent error to %s: %s", conn.RemoteAddr().String(), message)
}
