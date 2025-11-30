package http

import (
	"encoding/json"

	"github.com/hype-comms/hmm-chat/internal/domain"
)

// CreateChannelRequest is the request to create a channel
type CreateChannelRequest struct {
	Name string `json:"name"`
}

// ChannelResponse is the response with channel data
type ChannelResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}

// SendMessageRequest is the request to send a message
type SendMessageRequest struct {
	Text string `json:"text"`
}

// MessageResponse is the response with message data
type MessageResponse struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	AuthorID  string `json:"author_id"`
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
}

// ErrorResponse is the response for errors
type ErrorResponse struct {
	Error string `json:"error"`
}

// DomainChannelToResponse converts a domain channel to a response
func DomainChannelToResponse(ch *domain.Channel) ChannelResponse {
	return ChannelResponse{
		ID:        string(ch.ID),
		Name:      ch.Name,
		CreatedAt: ch.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

// DomainMessageToResponse converts a domain message to a response
func DomainMessageToResponse(msg *domain.Message) MessageResponse {
	return MessageResponse{
		ID:        string(msg.ID),
		ChannelID: string(msg.ChannelID),
		AuthorID:  string(msg.AuthorID),
		Text:      msg.Text,
		CreatedAt: msg.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

// WebSocketMessage is a message sent over WebSocket
type WebSocketMessage struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Error   string          `json:"error,omitempty"`
}

// SubscribePayload is the payload for subscribing to a channel
type SubscribePayload struct {
	ChannelID string `json:"channel_id"`
}

// SendMessagePayload is the payload for sending a message
type SendMessagePayload struct {
	ChannelID string `json:"channel_id"`
	AuthorID  string `json:"author_id"`
	Text      string `json:"text"`
}

// CreateChannelPayload is the payload for creating a channel
type CreateChannelPayload struct {
	Name string `json:"name"`
}

// GetHistoryPayload is the payload for getting message history
type GetHistoryPayload struct {
	ChannelID string `json:"channel_id"`
	Limit     int    `json:"limit"`
	Offset    int    `json:"offset"`
}
