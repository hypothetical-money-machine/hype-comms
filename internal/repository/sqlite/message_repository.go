package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/hype-comms/hmm-chat/internal/domain"
)

// MessageRepository is a SQLite implementation of the MessageRepository interface
type MessageRepository struct {
	db *Database
}

// NewMessageRepository creates a new SQLite message repository
func NewMessageRepository(db *Database) *MessageRepository {
	return &MessageRepository{db: db}
}

// SaveMessage saves a message to the database
func (r *MessageRepository) SaveMessage(ctx context.Context, msg *domain.Message) error {
	now := time.Now()
	_, err := r.db.conn.ExecContext(ctx, `
		INSERT INTO messages (id, channel_id, text, created_at)
		VALUES (?, ?, ?, ?)
	`, string(msg.ID), string(msg.ChannelID), msg.Text, now)

	if err != nil {
		return fmt.Errorf("failed to save message: %w", err)
	}

	msg.CreatedAt = now
	return nil
}

// GetMessage retrieves a message by ID from the database
func (r *MessageRepository) GetMessage(ctx context.Context, id domain.MessageID) (*domain.Message, error) {
	row := r.db.conn.QueryRowContext(ctx, `
		SELECT id, channel_id, text, created_at
		FROM messages
		WHERE id = ?
	`, string(id))

	var msgID string
	var channelID string
	var text string
	var createdAt string

	err := row.Scan(&msgID, &channelID, &text, &createdAt)
	if err == sql.ErrNoRows {
		return nil, domain.ErrMessageNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get message: %w", err)
	}

	msg := &domain.Message{
		ID:        domain.MessageID(msgID),
		ChannelID: domain.ChannelID(channelID),
		Text:      text,
	}
	msg.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)

	return msg, nil
}

// ListMessages retrieves messages from a channel with pagination
func (r *MessageRepository) ListMessages(ctx context.Context, channelID domain.ChannelID, limit, offset int) ([]*domain.Message, error) {
	rows, err := r.db.conn.QueryContext(ctx, `
		SELECT id, channel_id, text, created_at
		FROM messages
		WHERE channel_id = ?
		ORDER BY created_at DESC
		LIMIT ? OFFSET ?
	`, string(channelID), limit, offset)

	if err != nil {
		return nil, fmt.Errorf("failed to list messages: %w", err)
	}
	defer rows.Close()

	var messages []*domain.Message
	for rows.Next() {
		var msgID string
		var chID string
		var text string
		var createdAt string

		err := rows.Scan(&msgID, &chID, &text, &createdAt)
		if err != nil {
			return nil, fmt.Errorf("failed to scan message: %w", err)
		}

		msg := &domain.Message{
			ID:        domain.MessageID(msgID),
			ChannelID: domain.ChannelID(chID),
			Text:      text,
		}
		msg.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)

		messages = append(messages, msg)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate messages: %w", err)
	}

	return messages, nil
}
