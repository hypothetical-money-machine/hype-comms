package broadcaster

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/hype-comms/hmm-chat/internal/domain"
)

// subscriber wraps a message channel with closed state tracking
// to prevent panics from sending on closed channels
type subscriber struct {
	ch     chan *domain.Message
	closed atomic.Bool
}

// Broadcaster is an in-memory implementation of the MessageBroadcaster interface
type Broadcaster struct {
	mu       sync.RWMutex
	channels map[domain.ChannelID][]*subscriber
	closed   atomic.Bool
}

// New creates a new broadcaster
func New() *Broadcaster {
	return &Broadcaster{
		channels: make(map[domain.ChannelID][]*subscriber),
	}
}

// Subscribe subscribes to messages from a channel
func (b *Broadcaster) Subscribe(ctx context.Context, channelID domain.ChannelID) (<-chan *domain.Message, error) {
	if b.closed.Load() {
		return nil, context.Canceled
	}

	sub := &subscriber{
		ch: make(chan *domain.Message, 10), // Buffered to avoid blocking
	}

	b.mu.Lock()
	b.channels[channelID] = append(b.channels[channelID], sub)
	b.mu.Unlock()

	return sub.ch, nil
}

// Unsubscribe unsubscribes from messages in a channel
func (b *Broadcaster) Unsubscribe(ctx context.Context, channelID domain.ChannelID, ch <-chan *domain.Message) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	subscribers, exists := b.channels[channelID]
	if !exists {
		return nil
	}

	// Find and remove the subscriber
	for i, sub := range subscribers {
		if sub.ch == ch {
			// Mark as closed BEFORE closing to prevent sends
			sub.closed.Store(true)
			close(sub.ch)
			b.channels[channelID] = append(subscribers[:i], subscribers[i+1:]...)
			break
		}
	}

	return nil
}

// Broadcast broadcasts a message to all subscribers of a channel
func (b *Broadcaster) Broadcast(ctx context.Context, channelID domain.ChannelID, msg *domain.Message) error {
	if b.closed.Load() {
		return context.Canceled
	}

	b.mu.RLock()
	subscribers, exists := b.channels[channelID]
	if !exists || len(subscribers) == 0 {
		b.mu.RUnlock()
		return nil // No subscribers
	}
	// Copy the slice to avoid race with Unsubscribe
	subscribersCopy := make([]*subscriber, len(subscribers))
	copy(subscribersCopy, subscribers)
	b.mu.RUnlock()

	// Broadcast to all subscribers (using the copy)
	for _, sub := range subscribersCopy {
		// Check if subscriber was closed (prevents panic on closed channel)
		if sub.closed.Load() {
			continue
		}
		select {
		case sub.ch <- msg:
		case <-ctx.Done():
			return ctx.Err()
		default:
			// Channel full, skip to avoid blocking
		}
	}

	return nil
}

// Close shuts down the broadcaster, closing all subscriber channels
func (b *Broadcaster) Close() error {
	if b.closed.Swap(true) {
		return nil // Already closed
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	for channelID, subscribers := range b.channels {
		for _, sub := range subscribers {
			if !sub.closed.Swap(true) {
				close(sub.ch)
			}
		}
		slog.Debug("Closed channel subscribers", "channel_id", channelID, "count", len(subscribers))
	}
	b.channels = make(map[domain.ChannelID][]*subscriber)

	slog.Debug("Broadcaster closed")
	return nil
}
