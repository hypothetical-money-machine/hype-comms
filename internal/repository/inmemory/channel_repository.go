package inmemory

import (
	"context"
	"sync"

	"github.com/hype-comms/hmm-chat/internal/domain"
)

// ChannelRepository is an in-memory implementation of the ChannelRepository interface
type ChannelRepository struct {
	mu       sync.RWMutex
	channels map[domain.ChannelID]*domain.Channel
}

// NewChannelRepository creates a new in-memory channel repository
func NewChannelRepository() *ChannelRepository {
	return &ChannelRepository{
		channels: make(map[domain.ChannelID]*domain.Channel),
	}
}

// CreateChannel creates a new channel
func (r *ChannelRepository) CreateChannel(ctx context.Context, ch *domain.Channel) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Check if channel already exists
	for _, existing := range r.channels {
		if existing.Name == ch.Name {
			return domain.ErrChannelAlreadyExists
		}
	}

	r.channels[ch.ID] = ch
	return nil
}

// GetChannel retrieves a channel by ID
func (r *ChannelRepository) GetChannel(ctx context.Context, id domain.ChannelID) (*domain.Channel, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	ch, exists := r.channels[id]
	if !exists {
		return nil, domain.ErrChannelNotFound
	}

	return ch, nil
}

// ListChannels returns all channels
func (r *ChannelRepository) ListChannels(ctx context.Context) ([]*domain.Channel, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	channels := make([]*domain.Channel, 0, len(r.channels))
	for _, ch := range r.channels {
		channels = append(channels, ch)
	}

	return channels, nil
}

// DeleteChannel deletes a channel by ID
func (r *ChannelRepository) DeleteChannel(ctx context.Context, id domain.ChannelID) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.channels[id]; !exists {
		return domain.ErrChannelNotFound
	}

	delete(r.channels, id)
	return nil
}
