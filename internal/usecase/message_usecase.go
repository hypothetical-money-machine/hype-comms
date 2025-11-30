package usecase

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/hype-comms/hmm-chat/internal/domain"
)

// MessageUseCase handles message-related business logic
type MessageUseCase struct {
	messageRepo   MessageRepository
	broadcaster   MessageBroadcaster
	channelRepo   ChannelRepository
}

// NewMessageUseCase creates a new message use case
func NewMessageUseCase(mr MessageRepository, b MessageBroadcaster, cr ChannelRepository) *MessageUseCase {
	return &MessageUseCase{
		messageRepo:   mr,
		broadcaster:   b,
		channelRepo:   cr,
	}
}

// SendMessage sends a message to a channel
func (uc *MessageUseCase) SendMessage(ctx context.Context, channelID domain.ChannelID, authorID domain.UserID, text string) (*domain.Message, error) {
	// Verify channel exists
	if _, err := uc.channelRepo.GetChannel(ctx, channelID); err != nil {
		return nil, err
	}

	msg := &domain.Message{
		ID:        domain.MessageID(uuid.New().String()),
		ChannelID: channelID,
		AuthorID:  authorID,
		Text:      text,
		CreatedAt: time.Now(),
	}

	if err := msg.Validate(); err != nil {
		return nil, err
	}

	if err := uc.messageRepo.SaveMessage(ctx, msg); err != nil {
		return nil, err
	}

	// Broadcast to subscribers (synchronous but non-blocking internally)
	// The broadcaster uses select with default case, so this won't block on slow subscribers
	if err := uc.broadcaster.Broadcast(ctx, channelID, msg); err != nil {
		// Log but don't fail - message is persisted, real-time delivery is best-effort
		slog.Warn("Failed to broadcast message", "message_id", msg.ID, "channel_id", channelID, "error", err)
	}

	return msg, nil
}

// GetMessage retrieves a message by ID
func (uc *MessageUseCase) GetMessage(ctx context.Context, id domain.MessageID) (*domain.Message, error) {
	return uc.messageRepo.GetMessage(ctx, id)
}

// GetMessages retrieves messages from a channel with pagination
func (uc *MessageUseCase) GetMessages(ctx context.Context, channelID domain.ChannelID, limit, offset int) ([]*domain.Message, error) {
	return uc.messageRepo.ListMessages(ctx, channelID, limit, offset)
}
