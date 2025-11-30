package usecase

import (
	"context"

	"github.com/hype-comms/hmm-chat/internal/domain"
)

// ChannelRepository defines the interface for channel persistence
type ChannelRepository interface {
	CreateChannel(ctx context.Context, ch *domain.Channel) error
	GetChannel(ctx context.Context, id domain.ChannelID) (*domain.Channel, error)
	ListChannels(ctx context.Context) ([]*domain.Channel, error)
	DeleteChannel(ctx context.Context, id domain.ChannelID) error
}

// MessageRepository defines the interface for message persistence
type MessageRepository interface {
	SaveMessage(ctx context.Context, msg *domain.Message) error
	GetMessage(ctx context.Context, id domain.MessageID) (*domain.Message, error)
	ListMessages(ctx context.Context, channelID domain.ChannelID, limit, offset int) ([]*domain.Message, error)
}

// MessageBroadcaster defines the interface for broadcasting messages in real-time
type MessageBroadcaster interface {
	Broadcast(ctx context.Context, channelID domain.ChannelID, msg *domain.Message) error
	Subscribe(ctx context.Context, channelID domain.ChannelID) (<-chan *domain.Message, error)
	Unsubscribe(ctx context.Context, channelID domain.ChannelID, ch <-chan *domain.Message) error
	Close() error
}
