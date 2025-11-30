package inmemory

import (
	"context"
	"sort"
	"sync"

	"github.com/hype-comms/hmm-chat/internal/domain"
)

// ChannelRepository is an in-memory implementation of the ChannelRepository interface
type ChannelRepository struct {
	mu          sync.RWMutex
	channels    map[domain.ChannelID]*domain.Channel
	nameToID    map[string]domain.ChannelID // Index for O(1) name lookups
}

// NewChannelRepository creates a new in-memory channel repository
func NewChannelRepository() *ChannelRepository {
	return &ChannelRepository{
		channels: make(map[domain.ChannelID]*domain.Channel),
		nameToID: make(map[string]domain.ChannelID),
	}
}

// CreateChannel creates a new channel
func (r *ChannelRepository) CreateChannel(ctx context.Context, ch *domain.Channel) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Check if channel name already exists (O(1) lookup)
	if _, exists := r.nameToID[ch.Name]; exists {
		return domain.ErrChannelAlreadyExists
	}

	r.channels[ch.ID] = ch
	r.nameToID[ch.Name] = ch.ID
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

// maxChannelsLimit is the maximum number of channels to return
const maxChannelsLimit = 1000

// ListChannels returns all channels (limited to prevent unbounded results)
// Channels are sorted by CreatedAt DESC to match SQLite behavior
func (r *ChannelRepository) ListChannels(ctx context.Context) ([]*domain.Channel, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	channels := make([]*domain.Channel, 0, len(r.channels))
	for _, ch := range r.channels {
		channels = append(channels, ch)
	}

	// Sort by CreatedAt DESC (newest first) to match SQLite behavior
	sort.Slice(channels, func(i, j int) bool {
		return channels[i].CreatedAt.After(channels[j].CreatedAt)
	})

	// Apply limit
	if len(channels) > maxChannelsLimit {
		channels = channels[:maxChannelsLimit]
	}

	return channels, nil
}

// DeleteChannel deletes a channel by ID
func (r *ChannelRepository) DeleteChannel(ctx context.Context, id domain.ChannelID) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	ch, exists := r.channels[id]
	if !exists {
		return domain.ErrChannelNotFound
	}

	delete(r.nameToID, ch.Name)
	delete(r.channels, id)
	return nil
}
