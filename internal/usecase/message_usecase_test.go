package usecase

import (
	"context"
	"testing"
	"time"

	"github.com/hype-comms/hmm-chat/internal/domain"
	"github.com/hype-comms/hmm-chat/internal/platform/broadcaster"
	"github.com/hype-comms/hmm-chat/internal/repository/inmemory"
)

func setupMessageUseCase() (*MessageUseCase, *ChannelUseCase) {
	channelRepo := inmemory.NewChannelRepository()
	messageRepo := inmemory.NewMessageRepository()
	bc := broadcaster.New()

	channelUC := NewChannelUseCase(channelRepo)
	messageUC := NewMessageUseCase(messageRepo, bc, channelRepo)

	return messageUC, channelUC
}

func TestMessageUseCase_SendMessage(t *testing.T) {
	ctx := context.Background()

	t.Run("sends message successfully", func(t *testing.T) {
		messageUC, channelUC := setupMessageUseCase()

		channel, _ := channelUC.CreateChannel(ctx, "test-channel")

		msg, err := messageUC.SendMessage(ctx, channel.ID, "hello world")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if msg.Text != "hello world" {
			t.Errorf("expected text 'hello world', got %q", msg.Text)
		}
		if msg.ChannelID != channel.ID {
			t.Errorf("expected channel ID %q, got %q", channel.ID, msg.ChannelID)
		}
		if msg.ID == "" {
			t.Error("expected non-empty message ID")
		}
	})

	t.Run("rejects empty message", func(t *testing.T) {
		messageUC, channelUC := setupMessageUseCase()

		channel, _ := channelUC.CreateChannel(ctx, "test-channel")

		_, err := messageUC.SendMessage(ctx, channel.ID, "")
		if err != domain.ErrMessageEmpty {
			t.Errorf("expected ErrMessageEmpty, got %v", err)
		}
	})

	t.Run("rejects message to non-existent channel", func(t *testing.T) {
		messageUC, _ := setupMessageUseCase()

		_, err := messageUC.SendMessage(ctx, "non-existent", "hello")
		if err != domain.ErrChannelNotFound {
			t.Errorf("expected ErrChannelNotFound, got %v", err)
		}
	})
}

func TestMessageUseCase_GetMessages(t *testing.T) {
	ctx := context.Background()

	t.Run("retrieves messages with pagination", func(t *testing.T) {
		messageUC, channelUC := setupMessageUseCase()

		channel, _ := channelUC.CreateChannel(ctx, "test-channel")

		// Send multiple messages
		for i := 0; i < 5; i++ {
			messageUC.SendMessage(ctx, channel.ID, "message")
			time.Sleep(time.Millisecond) // Ensure different timestamps
		}

		messages, err := messageUC.GetMessages(ctx, channel.ID, 3, 0)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(messages) != 3 {
			t.Errorf("expected 3 messages, got %d", len(messages))
		}
	})

	t.Run("returns empty for non-existent channel", func(t *testing.T) {
		messageUC, _ := setupMessageUseCase()

		messages, err := messageUC.GetMessages(ctx, "non-existent", 10, 0)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(messages) != 0 {
			t.Errorf("expected 0 messages, got %d", len(messages))
		}
	})
}

func TestMessageUseCase_GetMessage(t *testing.T) {
	ctx := context.Background()

	t.Run("gets existing message", func(t *testing.T) {
		messageUC, channelUC := setupMessageUseCase()

		channel, _ := channelUC.CreateChannel(ctx, "test-channel")
		sent, _ := messageUC.SendMessage(ctx, channel.ID, "test message")

		got, err := messageUC.GetMessage(ctx, sent.ID)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.ID != sent.ID {
			t.Errorf("expected ID %q, got %q", sent.ID, got.ID)
		}
	})

	t.Run("returns error for non-existent message", func(t *testing.T) {
		messageUC, _ := setupMessageUseCase()

		_, err := messageUC.GetMessage(ctx, "non-existent")
		if err != domain.ErrMessageNotFound {
			t.Errorf("expected ErrMessageNotFound, got %v", err)
		}
	})
}
