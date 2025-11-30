package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
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
	authorID := msg.AuthorID
	if authorID == "" {
		authorID = "anonymous"
	}

	_, err := r.db.conn.ExecContext(ctx, `
		INSERT INTO messages (id, channel_id, author_id, text, created_at)
		VALUES (?, ?, ?, ?, ?)
	`, string(msg.ID), string(msg.ChannelID), string(authorID), msg.Text, now)

	if err != nil {
		return fmt.Errorf("failed to save message: %w", err)
	}

	msg.CreatedAt = now
	msg.AuthorID = authorID
	return nil
}

// GetMessage retrieves a message by ID from the database
func (r *MessageRepository) GetMessage(ctx context.Context, id domain.MessageID) (*domain.Message, error) {
	row := r.db.conn.QueryRowContext(ctx, `
		SELECT id, channel_id, author_id, text, created_at
		FROM messages
		WHERE id = ?
	`, string(id))

	var msgID string
	var channelID string
	var authorID string
	var text string
	var createdAt string

	err := row.Scan(&msgID, &channelID, &authorID, &text, &createdAt)
	if err == sql.ErrNoRows {
		return nil, domain.ErrMessageNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get message: %w", err)
	}

	msg := &domain.Message{
		ID:        domain.MessageID(msgID),
		ChannelID: domain.ChannelID(channelID),
		AuthorID:  domain.UserID(authorID),
		Text:      text,
	}
	if t, err := ParseSQLiteTime(createdAt); err != nil {
		slog.Warn("Failed to parse message created_at", "message_id", msgID, "value", createdAt, "error", err)
	} else {
		msg.CreatedAt = t
	}

	return msg, nil
}

// maxMessagesLimit is the maximum number of messages to return in a single query
const maxMessagesLimit = 100

// ListMessages retrieves messages from a channel with pagination
func (r *MessageRepository) ListMessages(ctx context.Context, channelID domain.ChannelID, limit, offset int) ([]*domain.Message, error) {
	// Validate and clamp pagination parameters
	if limit <= 0 {
		limit = 50 // Default limit
	}
	if limit > maxMessagesLimit {
		limit = maxMessagesLimit
	}
	if offset < 0 {
		offset = 0
	}

	rows, err := r.db.conn.QueryContext(ctx, `
		SELECT id, channel_id, author_id, text, created_at
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
		var authorID string
		var text string
		var createdAt string

		err := rows.Scan(&msgID, &chID, &authorID, &text, &createdAt)
		if err != nil {
			return nil, fmt.Errorf("failed to scan message: %w", err)
		}

		msg := &domain.Message{
			ID:        domain.MessageID(msgID),
			ChannelID: domain.ChannelID(chID),
			AuthorID:  domain.UserID(authorID),
			Text:      text,
		}
		if t, err := ParseSQLiteTime(createdAt); err != nil {
			slog.Warn("Failed to parse message created_at", "message_id", msgID, "value", createdAt, "error", err)
		} else {
			msg.CreatedAt = t
		}

		messages = append(messages, msg)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate messages: %w", err)
	}

	return messages, nil
}
