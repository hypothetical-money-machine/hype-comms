package http

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/hype-comms/hmm-chat/internal/domain"
	"github.com/hype-comms/hmm-chat/internal/usecase"
)

// contextKey is the type for context keys to avoid collisions
type contextKey string

const (
	// RequestIDKey is the context key for request/connection IDs
	RequestIDKey contextKey = "request_id"
)

const (
	// Time allowed to write a message to the peer
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer
	pongWait = 60 * time.Second

	// Send pings to peer with this period (must be less than pongWait)
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer
	maxMessageSize = 512 * 1024 // 512KB

	// Default rate limiting settings
	defaultRateLimit = 10              // messages per second
	defaultBurstSize = 20              // maximum burst size
)

// RateLimiter implements a token bucket rate limiter
type RateLimiter struct {
	mu         sync.Mutex
	tokens     float64
	maxTokens  float64
	refillRate float64   // tokens per second
	lastRefill time.Time
}

// NewRateLimiter creates a new rate limiter with specified rate and burst
func NewRateLimiter(rate, burst float64) *RateLimiter {
	return &RateLimiter{
		tokens:     burst,
		maxTokens:  burst,
		refillRate: rate,
		lastRefill: time.Now(),
	}
}

// Allow checks if an action is allowed and consumes a token if so
func (r *RateLimiter) Allow() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Refill tokens based on elapsed time
	now := time.Now()
	elapsed := now.Sub(r.lastRefill).Seconds()
	r.tokens += elapsed * r.refillRate
	if r.tokens > r.maxTokens {
		r.tokens = r.maxTokens
	}
	r.lastRefill = now

	// Check if we have tokens available
	if r.tokens >= 1 {
		r.tokens--
		return true
	}
	return false
}

// DefaultAllowedOrigins is the default list of allowed origins for WebSocket connections.
var DefaultAllowedOrigins = []string{
	"http://localhost",
	"http://localhost:8080",
	"http://127.0.0.1",
	"http://127.0.0.1:8080",
}

// makeUpgrader creates a WebSocket upgrader with the specified allowed origins
func makeUpgrader(allowedOrigins []string) websocket.Upgrader {
	return websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			// If no allowed origins configured, allow all (development mode)
			if len(allowedOrigins) == 0 {
				slog.Warn("No allowed origins configured, accepting all origins")
				return true
			}
			origin := r.Header.Get("Origin")
			// Allow requests with no origin (same-origin requests, CLI clients)
			if origin == "" {
				return true
			}
			for _, allowed := range allowedOrigins {
				if origin == allowed {
					return true
				}
			}
			slog.Warn("Rejected WebSocket connection", "origin", origin)
			return false
		},
	}
}

// subscription tracks a single channel subscription
type subscription struct {
	channelID domain.ChannelID
	msgChan   <-chan *domain.Message
}

// wsSession represents a WebSocket client session with all its subscriptions
type wsSession struct {
	conn          *websocket.Conn
	mu            sync.Mutex
	subscriptions []subscription
	done          chan struct{}
	ctx           context.Context
	cancel        context.CancelFunc
	rateLimiter   *RateLimiter
	requestID     string
	logger        *slog.Logger
}

func newWSSession(conn *websocket.Conn, rateLimit, burstSize float64) *wsSession {
	requestID := uuid.New().String()[:8] // Short request ID for easier logging
	ctx := context.WithValue(context.Background(), RequestIDKey, requestID)
	ctx, cancel := context.WithCancel(ctx)

	// Create a logger with the request ID for structured logging
	logger := slog.With("request_id", requestID, "client", conn.RemoteAddr().String())

	return &wsSession{
		conn:          conn,
		subscriptions: make([]subscription, 0),
		done:          make(chan struct{}),
		ctx:           ctx,
		cancel:        cancel,
		rateLimiter:   NewRateLimiter(rateLimit, burstSize),
		requestID:     requestID,
		logger:        logger,
	}
}

func (s *wsSession) WriteJSON(v interface{}) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(writeWait))
	return s.conn.WriteJSON(v)
}

func (s *wsSession) WriteControl(messageType int, data []byte, deadline time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.WriteControl(messageType, data, deadline)
}

func (s *wsSession) ReadJSON(v interface{}) error {
	return s.conn.ReadJSON(v)
}

func (s *wsSession) RemoteAddr() string {
	return s.conn.RemoteAddr().String()
}

func (s *wsSession) addSubscription(channelID domain.ChannelID, msgChan <-chan *domain.Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subscriptions = append(s.subscriptions, subscription{channelID: channelID, msgChan: msgChan})
}

func (s *wsSession) getSubscriptions() []subscription {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Return a copy to avoid race conditions
	result := make([]subscription, len(s.subscriptions))
	copy(result, s.subscriptions)
	return result
}

func (s *wsSession) close() {
	s.cancel() // Cancel the context
	close(s.done)
}

func (s *wsSession) Context() context.Context {
	return s.ctx
}

// WSServer handles WebSocket connections
type WSServer struct {
	broadcaster    usecase.MessageBroadcaster
	messageUC      *usecase.MessageUseCase
	channelUC      *usecase.ChannelUseCase
	upgrader       websocket.Upgrader
	allowedOrigins []string
	rateLimit      float64
	burstSize      float64
}

// WSServerOption is a functional option for configuring WSServer
type WSServerOption func(*WSServer)

// WithAllowedOrigins sets the allowed origins for WebSocket connections
func WithAllowedOrigins(origins []string) WSServerOption {
	return func(s *WSServer) {
		s.allowedOrigins = origins
	}
}

// WithRateLimit sets the rate limit (messages per second) and burst size for WebSocket connections
func WithRateLimit(rate, burst float64) WSServerOption {
	return func(s *WSServer) {
		s.rateLimit = rate
		s.burstSize = burst
	}
}

// NewWSServer creates a new WebSocket server
func NewWSServer(b usecase.MessageBroadcaster, msgUC *usecase.MessageUseCase, chUC *usecase.ChannelUseCase, opts ...WSServerOption) *WSServer {
	s := &WSServer{
		broadcaster:    b,
		messageUC:      msgUC,
		channelUC:      chUC,
		allowedOrigins: DefaultAllowedOrigins,
		rateLimit:      defaultRateLimit,
		burstSize:      defaultBurstSize,
	}

	for _, opt := range opts {
		opt(s)
	}

	s.upgrader = makeUpgrader(s.allowedOrigins)
	return s
}

// HandleWebSocket upgrades HTTP connection to WebSocket and handles it
func (s *WSServer) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	rawConn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("WebSocket upgrade error", "error", err)
		return
	}
	defer rawConn.Close()

	session := newWSSession(rawConn, s.rateLimit, s.burstSize)
	session.logger.Info("WebSocket client connected")

	// Configure connection limits and timeouts
	rawConn.SetReadLimit(maxMessageSize)
	rawConn.SetReadDeadline(time.Now().Add(pongWait))
	rawConn.SetPongHandler(func(string) error {
		rawConn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// Start ping ticker to detect dead connections
	pingTicker := time.NewTicker(pingPeriod)
	defer pingTicker.Stop()

	go func() {
		for {
			select {
			case <-pingTicker.C:
				if err := session.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(writeWait)); err != nil {
					session.logger.Debug("WebSocket ping failed", "error", err)
					return
				}
			case <-session.done:
				return
			}
		}
	}()

	// Ensure cleanup on disconnect
	defer func() {
		session.close() // Signal all subscription goroutines to exit and cancel context
		// Unsubscribe from all channels (use a fresh context since session context is cancelled)
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for _, sub := range session.getSubscriptions() {
			if err := s.broadcaster.Unsubscribe(cleanupCtx, sub.channelID, sub.msgChan); err != nil {
				session.logger.Warn("Failed to unsubscribe from channel", "channel_id", sub.channelID, "error", err)
			}
		}
		session.logger.Debug("WebSocket client cleanup complete", "subscriptions", len(session.getSubscriptions()))
	}()

	// Handle messages from this client
	for {
		var wsMsg WebSocketMessage
		if err := session.ReadJSON(&wsMsg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				session.logger.Debug("WebSocket client disconnected", "error", err)
			}
			return
		}

		// Reset read deadline after successful read
		rawConn.SetReadDeadline(time.Now().Add(pongWait))

		session.logger.Debug("WebSocket message received", "type", wsMsg.Type)

		// Rate limiting for mutating operations
		if wsMsg.Type == "send" || wsMsg.Type == "create_channel" {
			if !session.rateLimiter.Allow() {
				session.logger.Warn("Rate limit exceeded", "type", wsMsg.Type)
				s.sendError(session, "Rate limit exceeded, please slow down")
				continue
			}
		}

		// Handle different message types
		switch wsMsg.Type {
		case "subscribe":
			s.handleSubscribe(session, wsMsg)
		case "unsubscribe":
			s.handleUnsubscribe(session, wsMsg)
		case "send":
			s.handleSend(session, wsMsg)
		case "create_channel":
			s.handleCreateChannel(session, wsMsg)
		case "list_channels":
			s.handleListChannels(session)
		case "history":
			s.handleHistory(session, wsMsg)
		default:
			s.sendError(session, "Unknown message type")
		}
	}
}

// handleSubscribe subscribes the client to a channel
func (s *WSServer) handleSubscribe(session *wsSession, wsMsg WebSocketMessage) {
	var payload SubscribePayload
	if err := json.Unmarshal(wsMsg.Payload, &payload); err != nil {
		s.sendError(session, "Invalid subscribe payload")
		return
	}

	channelID := domain.ChannelID(payload.ChannelID)
	ctx := session.Context()

	// Verify channel exists
	if _, err := s.channelUC.GetChannel(ctx, channelID); err != nil {
		s.sendError(session, "Channel not found")
		return
	}

	// Subscribe to channel
	msgChan, err := s.broadcaster.Subscribe(ctx, channelID)
	if err != nil {
		s.sendError(session, "Failed to subscribe")
		return
	}

	// Track subscription for cleanup
	session.addSubscription(channelID, msgChan)

	// Send acknowledgement
	s.sendMessage(session, "subscribed", map[string]string{"channel_id": string(channelID)})

	// Listen for messages from the channel in a goroutine
	go func() {
		for {
			select {
			case msg, ok := <-msgChan:
				if !ok {
					// Channel closed (unsubscribed)
					return
				}
				s.sendMessage(session, "message", DomainMessageToResponse(msg))
			case <-session.done:
				// Session closed, exit goroutine
				return
			}
		}
	}()
}

// handleUnsubscribe unsubscribes the client from a channel
func (s *WSServer) handleUnsubscribe(session *wsSession, wsMsg WebSocketMessage) {
	var payload SubscribePayload // Reuse same payload structure
	if err := json.Unmarshal(wsMsg.Payload, &payload); err != nil {
		s.sendError(session, "Invalid unsubscribe payload")
		return
	}

	channelID := domain.ChannelID(payload.ChannelID)
	ctx := session.Context()

	// Find and remove the subscription
	session.mu.Lock()
	var found bool
	var msgChan <-chan *domain.Message
	for i, sub := range session.subscriptions {
		if sub.channelID == channelID {
			msgChan = sub.msgChan
			session.subscriptions = append(session.subscriptions[:i], session.subscriptions[i+1:]...)
			found = true
			break
		}
	}
	session.mu.Unlock()

	if !found {
		s.sendError(session, "Not subscribed to this channel")
		return
	}

	// Unsubscribe from broadcaster
	if err := s.broadcaster.Unsubscribe(ctx, channelID, msgChan); err != nil {
		session.logger.Warn("Failed to unsubscribe from channel", "channel_id", channelID, "error", err)
	}

	s.sendMessage(session, "unsubscribed", map[string]string{"channel_id": string(channelID)})
}

// handleSend sends a message to a channel
func (s *WSServer) handleSend(session *wsSession, wsMsg WebSocketMessage) {
	var payload SendMessagePayload
	if err := json.Unmarshal(wsMsg.Payload, &payload); err != nil {
		s.sendError(session, "Invalid send payload")
		return
	}

	channelID := domain.ChannelID(payload.ChannelID)
	authorID := domain.UserID(payload.AuthorID)
	if authorID == "" {
		authorID = "anonymous"
	}
	ctx := session.Context()

	msg, err := s.messageUC.SendMessage(ctx, channelID, authorID, payload.Text)
	if err != nil {
		s.sendError(session, err.Error())
		return
	}

	// Send acknowledgement
	s.sendMessage(session, "message_sent", DomainMessageToResponse(msg))
}

// handleCreateChannel creates a new channel
func (s *WSServer) handleCreateChannel(session *wsSession, wsMsg WebSocketMessage) {
	var payload CreateChannelPayload
	if err := json.Unmarshal(wsMsg.Payload, &payload); err != nil {
		s.sendError(session, "Invalid create_channel payload")
		return
	}

	ctx := session.Context()
	ch, err := s.channelUC.CreateChannel(ctx, payload.Name)
	if err != nil {
		s.sendError(session, err.Error())
		return
	}

	s.sendMessage(session, "channel_created", DomainChannelToResponse(ch))
}

// handleListChannels returns all channels
func (s *WSServer) handleListChannels(session *wsSession) {
	ctx := session.Context()
	channels, err := s.channelUC.ListChannels(ctx)
	if err != nil {
		s.sendError(session, "Failed to list channels")
		return
	}

	responses := make([]ChannelResponse, len(channels))
	for i, ch := range channels {
		responses[i] = DomainChannelToResponse(ch)
	}

	s.sendMessage(session, "channels_list", map[string]interface{}{"channels": responses})
}

// handleHistory sends message history for a channel
func (s *WSServer) handleHistory(session *wsSession, wsMsg WebSocketMessage) {
	var payload GetHistoryPayload
	if err := json.Unmarshal(wsMsg.Payload, &payload); err != nil {
		s.sendError(session, "Invalid history payload")
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

	ctx := session.Context()
	messages, err := s.messageUC.GetMessages(ctx, channelID, limit, payload.Offset)
	if err != nil {
		s.sendError(session, "Failed to get history")
		return
	}

	responses := make([]MessageResponse, len(messages))
	for i, msg := range messages {
		responses[i] = DomainMessageToResponse(msg)
	}

	s.sendMessage(session, "history", map[string]interface{}{
		"channel_id": payload.ChannelID,
		"messages":   responses,
	})
}

// sendMessage sends a WebSocket message to the client
func (s *WSServer) sendMessage(session *wsSession, msgType string, payload interface{}) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		session.logger.Error("Failed to marshal WebSocket payload", "type", msgType, "error", err)
		return
	}

	wsMsg := WebSocketMessage{
		Type:    msgType,
		Payload: payloadBytes,
	}

	if err := session.WriteJSON(wsMsg); err != nil {
		session.logger.Error("Failed to send WebSocket message", "type", msgType, "error", err)
		return
	}
	session.logger.Debug("Sent WebSocket message", "type", msgType)
}

// sendError sends an error message to the client
func (s *WSServer) sendError(session *wsSession, message string) {
	wsMsg := WebSocketMessage{
		Type:  "error",
		Error: message,
	}

	if err := session.WriteJSON(wsMsg); err != nil {
		session.logger.Error("Failed to send error message", "error", err)
		return
	}
	session.logger.Debug("Sent error to client", "message", message)
}
