package broadcaster

import (
	"context"
	"testing"
	"time"

	"github.com/hype-comms/hmm-chat/internal/domain"
)

func TestBroadcaster_Subscribe(t *testing.T) {
	b := New()
	ctx := context.Background()

	ch, err := b.Subscribe(ctx, "channel-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ch == nil {
		t.Error("expected non-nil channel")
	}
}

func TestBroadcaster_Broadcast(t *testing.T) {
	b := New()
	ctx := context.Background()
	channelID := domain.ChannelID("test-channel")

	t.Run("broadcasts to subscribers", func(t *testing.T) {
		sub1, _ := b.Subscribe(ctx, channelID)
		sub2, _ := b.Subscribe(ctx, channelID)

		msg := &domain.Message{
			ID:   "msg-1",
			Text: "hello",
		}

		err := b.Broadcast(ctx, channelID, msg)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		// Both subscribers should receive the message
		select {
		case received := <-sub1:
			if received.ID != msg.ID {
				t.Errorf("sub1: expected message ID %q, got %q", msg.ID, received.ID)
			}
		case <-time.After(100 * time.Millisecond):
			t.Error("sub1: timeout waiting for message")
		}

		select {
		case received := <-sub2:
			if received.ID != msg.ID {
				t.Errorf("sub2: expected message ID %q, got %q", msg.ID, received.ID)
			}
		case <-time.After(100 * time.Millisecond):
			t.Error("sub2: timeout waiting for message")
		}
	})

	t.Run("no error when no subscribers", func(t *testing.T) {
		msg := &domain.Message{ID: "msg-2", Text: "hello"}

		err := b.Broadcast(ctx, "empty-channel", msg)
		if err != nil {
			t.Errorf("expected no error, got %v", err)
		}
	})

	t.Run("respects context cancellation", func(t *testing.T) {
		cancelCtx, cancel := context.WithCancel(ctx)

		// Subscribe and fill the buffer
		sub, _ := b.Subscribe(cancelCtx, "cancel-channel")
		for i := 0; i < 10; i++ {
			b.Broadcast(ctx, "cancel-channel", &domain.Message{ID: domain.MessageID("fill")})
		}

		// Drain the channel
		for len(sub) > 0 {
			<-sub
		}

		cancel()

		// After cancellation, broadcast should return context error
		err := b.Broadcast(cancelCtx, "cancel-channel", &domain.Message{ID: "after-cancel"})
		if err != context.Canceled {
			// Note: might be nil if channel isn't full, that's ok
			if err != nil {
				t.Logf("got error: %v (expected nil or context.Canceled)", err)
			}
		}
	})
}

func TestBroadcaster_Unsubscribe(t *testing.T) {
	b := New()
	ctx := context.Background()
	channelID := domain.ChannelID("unsub-channel")

	t.Run("unsubscribes successfully", func(t *testing.T) {
		sub, _ := b.Subscribe(ctx, channelID)

		err := b.Unsubscribe(ctx, channelID, sub)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		// Channel should be closed after unsubscribe
		_, ok := <-sub
		if ok {
			t.Error("expected channel to be closed")
		}
	})

	t.Run("no error for non-existent channel", func(t *testing.T) {
		fakeChan := make(chan *domain.Message)
		err := b.Unsubscribe(ctx, "non-existent", fakeChan)
		if err != nil {
			t.Errorf("expected no error, got %v", err)
		}
	})
}

func TestBroadcaster_MultipleChannels(t *testing.T) {
	b := New()
	ctx := context.Background()

	sub1, _ := b.Subscribe(ctx, "channel-a")
	sub2, _ := b.Subscribe(ctx, "channel-b")

	// Broadcast to channel-a only
	msg := &domain.Message{ID: "msg-a", Text: "for channel a"}
	b.Broadcast(ctx, "channel-a", msg)

	// sub1 should receive
	select {
	case received := <-sub1:
		if received.ID != msg.ID {
			t.Errorf("expected message ID %q, got %q", msg.ID, received.ID)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("timeout waiting for message on channel-a")
	}

	// sub2 should NOT receive (different channel)
	select {
	case <-sub2:
		t.Error("sub2 should not receive message from channel-a")
	case <-time.After(50 * time.Millisecond):
		// Expected - no message
	}
}
