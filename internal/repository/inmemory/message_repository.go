package inmemory

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/hype-comms/hmm-chat/internal/domain"
)

// MessageRepository is an in-memory implementation of the MessageRepository interface
type MessageRepository struct {
	mu       sync.RWMutex
	messages []*domain.Message
}

// NewMessageRepository creates a new in-memory message repository
func NewMessageRepository() *MessageRepository {
	return &MessageRepository{
		messages: make([]*domain.Message, 0),
	}
}

// SaveMessage saves a message
func (r *MessageRepository) SaveMessage(ctx context.Context, msg *domain.Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if msg.CreatedAt.IsZero() {
		msg.CreatedAt = time.Now()
	}

	r.messages = append(r.messages, msg)
	return nil
}

// GetMessage retrieves a message by ID
func (r *MessageRepository) GetMessage(ctx context.Context, id domain.MessageID) (*domain.Message, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, msg := range r.messages {
		if msg.ID == id {
			return msg, nil
		}
	}

	return nil, domain.ErrMessageNotFound
}

// maxMessagesLimit is the maximum number of messages to return in a single query
const maxMessagesLimit = 100

// ListMessages retrieves messages from a channel with pagination
func (r *MessageRepository) ListMessages(ctx context.Context, channelID domain.ChannelID, limit, offset int) ([]*domain.Message, error) {
	// Validate and clamp pagination parameters
	if limit <= 0 {
		limit = 50 // Default limit
	}
	if limit > maxMessagesLimit {
		limit = maxMessagesLimit
	}
	if offset < 0 {
		offset = 0
	}

	r.mu.RLock()
	defer r.mu.RUnlock()

	// Filter messages by channel
	var filtered []*domain.Message
	for _, msg := range r.messages {
		if msg.ChannelID == channelID {
			filtered = append(filtered, msg)
		}
	}

	// Sort by timestamp (newest first)
	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].CreatedAt.After(filtered[j].CreatedAt)
	})

	// Apply pagination
	if offset >= len(filtered) {
		return []*domain.Message{}, nil
	}

	end := offset + limit
	if end > len(filtered) {
		end = len(filtered)
	}

	return filtered[offset:end], nil
}
