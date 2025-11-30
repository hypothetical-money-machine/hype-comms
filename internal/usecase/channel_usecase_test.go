package usecase

import (
	"context"
	"testing"

	"github.com/hype-comms/hmm-chat/internal/domain"
	"github.com/hype-comms/hmm-chat/internal/repository/inmemory"
)

func TestChannelUseCase_CreateChannel(t *testing.T) {
	repo := inmemory.NewChannelRepository()
	uc := NewChannelUseCase(repo)
	ctx := context.Background()

	t.Run("creates channel successfully", func(t *testing.T) {
		ch, err := uc.CreateChannel(ctx, "general")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if ch.Name != "general" {
			t.Errorf("expected name 'general', got %q", ch.Name)
		}
		if ch.ID == "" {
			t.Error("expected non-empty ID")
		}
	})

	t.Run("rejects empty name", func(t *testing.T) {
		_, err := uc.CreateChannel(ctx, "")
		if err != domain.ErrChannelNameRequired {
			t.Errorf("expected ErrChannelNameRequired, got %v", err)
		}
	})

	t.Run("rejects duplicate name", func(t *testing.T) {
		_, err := uc.CreateChannel(ctx, "duplicate")
		if err != nil {
			t.Fatalf("unexpected error on first create: %v", err)
		}

		_, err = uc.CreateChannel(ctx, "duplicate")
		if err != domain.ErrChannelAlreadyExists {
			t.Errorf("expected ErrChannelAlreadyExists, got %v", err)
		}
	})
}

func TestChannelUseCase_GetChannel(t *testing.T) {
	repo := inmemory.NewChannelRepository()
	uc := NewChannelUseCase(repo)
	ctx := context.Background()

	t.Run("gets existing channel", func(t *testing.T) {
		created, _ := uc.CreateChannel(ctx, "test-get")

		got, err := uc.GetChannel(ctx, created.ID)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.ID != created.ID {
			t.Errorf("expected ID %q, got %q", created.ID, got.ID)
		}
	})

	t.Run("returns error for non-existent channel", func(t *testing.T) {
		_, err := uc.GetChannel(ctx, "non-existent")
		if err != domain.ErrChannelNotFound {
			t.Errorf("expected ErrChannelNotFound, got %v", err)
		}
	})
}

func TestChannelUseCase_ListChannels(t *testing.T) {
	repo := inmemory.NewChannelRepository()
	uc := NewChannelUseCase(repo)
	ctx := context.Background()

	t.Run("lists all channels", func(t *testing.T) {
		uc.CreateChannel(ctx, "channel-1")
		uc.CreateChannel(ctx, "channel-2")

		channels, err := uc.ListChannels(ctx)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(channels) != 2 {
			t.Errorf("expected 2 channels, got %d", len(channels))
		}
	})
}

func TestChannelUseCase_DeleteChannel(t *testing.T) {
	repo := inmemory.NewChannelRepository()
	uc := NewChannelUseCase(repo)
	ctx := context.Background()

	t.Run("deletes existing channel", func(t *testing.T) {
		created, _ := uc.CreateChannel(ctx, "to-delete")

		err := uc.DeleteChannel(ctx, created.ID)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		_, err = uc.GetChannel(ctx, created.ID)
		if err != domain.ErrChannelNotFound {
			t.Errorf("expected channel to be deleted")
		}
	})

	t.Run("returns error for non-existent channel", func(t *testing.T) {
		err := uc.DeleteChannel(ctx, "non-existent")
		if err != domain.ErrChannelNotFound {
			t.Errorf("expected ErrChannelNotFound, got %v", err)
		}
	})
}
