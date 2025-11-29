package usecase

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/hype-comms/hmm-chat/internal/domain"
)

// ChannelUseCase handles channel-related business logic
type ChannelUseCase struct {
	channelRepo ChannelRepository
}

// NewChannelUseCase creates a new channel use case
func NewChannelUseCase(cr ChannelRepository) *ChannelUseCase {
	return &ChannelUseCase{
		channelRepo: cr,
	}
}

// CreateChannel creates a new channel
func (uc *ChannelUseCase) CreateChannel(ctx context.Context, name string) (*domain.Channel, error) {
	ch := &domain.Channel{
		ID:        domain.ChannelID(uuid.New().String()),
		Name:      name,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := ch.Validate(); err != nil {
		return nil, err
	}

	if err := uc.channelRepo.CreateChannel(ctx, ch); err != nil {
		return nil, err
	}

	return ch, nil
}

// GetChannel retrieves a channel by ID
func (uc *ChannelUseCase) GetChannel(ctx context.Context, id domain.ChannelID) (*domain.Channel, error) {
	return uc.channelRepo.GetChannel(ctx, id)
}

// ListChannels returns all channels
func (uc *ChannelUseCase) ListChannels(ctx context.Context) ([]*domain.Channel, error) {
	return uc.channelRepo.ListChannels(ctx)
}

// DeleteChannel deletes a channel by ID
func (uc *ChannelUseCase) DeleteChannel(ctx context.Context, id domain.ChannelID) error {
	return uc.channelRepo.DeleteChannel(ctx, id)
}
