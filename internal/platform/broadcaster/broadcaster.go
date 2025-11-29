package broadcaster

import (
	"context"
	"sync"

	"github.com/hype-comms/hmm-chat/internal/domain"
)

// Broadcaster is an in-memory implementation of the MessageBroadcaster interface
type Broadcaster struct {
	mu        sync.RWMutex
	channels  map[domain.ChannelID][]chan *domain.Message
}

// New creates a new broadcaster
func New() *Broadcaster {
	return &Broadcaster{
		channels: make(map[domain.ChannelID][]chan *domain.Message),
	}
}

// Subscribe subscribes to messages from a channel
func (b *Broadcaster) Subscribe(ctx context.Context, channelID domain.ChannelID) (<-chan *domain.Message, error) {
	ch := make(chan *domain.Message, 10) // Buffered to avoid blocking

	b.mu.Lock()
	b.channels[channelID] = append(b.channels[channelID], ch)
	b.mu.Unlock()

	return ch, nil
}

// Unsubscribe unsubscribes from messages in a channel
func (b *Broadcaster) Unsubscribe(ctx context.Context, channelID domain.ChannelID, ch <-chan *domain.Message) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	subscribers, exists := b.channels[channelID]
	if !exists {
		return nil
	}

	// Find and remove the channel
	for i, sub := range subscribers {
		if sub == ch {
			// Close the channel and remove it
			close(sub)
			b.channels[channelID] = append(subscribers[:i], subscribers[i+1:]...)
			break
		}
	}

	return nil
}

// Broadcast broadcasts a message to all subscribers of a channel
func (b *Broadcaster) Broadcast(ctx context.Context, channelID domain.ChannelID, msg *domain.Message) error {
	b.mu.RLock()
	subscribers, exists := b.channels[channelID]
	b.mu.RUnlock()

	if !exists {
		return nil // No subscribers
	}

	// Broadcast to all subscribers
	for _, ch := range subscribers {
		select {
		case ch <- msg:
		case <-ctx.Done():
			return ctx.Err()
		default:
			// Channel full, skip to avoid blocking
		}
	}

	return nil
}
