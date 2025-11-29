package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/hype-comms/hmm-chat/internal/domain"
)

// ChannelRepository is a SQLite implementation of the ChannelRepository interface
type ChannelRepository struct {
	db *Database
}

// NewChannelRepository creates a new SQLite channel repository
func NewChannelRepository(db *Database) *ChannelRepository {
	return &ChannelRepository{db: db}
}

// CreateChannel creates a new channel in the database
func (r *ChannelRepository) CreateChannel(ctx context.Context, ch *domain.Channel) error {
	now := time.Now()
	_, err := r.db.conn.ExecContext(ctx, `
		INSERT INTO channels (id, name, created_at, updated_at)
		VALUES (?, ?, ?, ?)
	`, string(ch.ID), ch.Name, now, now)

	if err != nil {
		// Check if it's a duplicate name error
		if err.Error() == "UNIQUE constraint failed: channels.name" {
			return domain.ErrChannelAlreadyExists
		}
		return fmt.Errorf("failed to create channel: %w", err)
	}

	ch.CreatedAt = now
	ch.UpdatedAt = now
	return nil
}

// GetChannel retrieves a channel by ID from the database
func (r *ChannelRepository) GetChannel(ctx context.Context, id domain.ChannelID) (*domain.Channel, error) {
	row := r.db.conn.QueryRowContext(ctx, `
		SELECT id, name, created_at, updated_at
		FROM channels
		WHERE id = ?
	`, string(id))

	var ch domain.Channel
	var channelID string
	var name string
	var createdAt string
	var updatedAt string

	err := row.Scan(&channelID, &name, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, domain.ErrChannelNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get channel: %w", err)
	}

	ch.ID = domain.ChannelID(channelID)
	ch.Name = name
	ch.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
	ch.UpdatedAt, _ = time.Parse("2006-01-02 15:04:05", updatedAt)

	return &ch, nil
}

// ListChannels returns all channels from the database
func (r *ChannelRepository) ListChannels(ctx context.Context) ([]*domain.Channel, error) {
	rows, err := r.db.conn.QueryContext(ctx, `
		SELECT id, name, created_at, updated_at
		FROM channels
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("failed to list channels: %w", err)
	}
	defer rows.Close()

	var channels []*domain.Channel
	for rows.Next() {
		var ch domain.Channel
		var channelID string
		var name string
		var createdAt string
		var updatedAt string

		err := rows.Scan(&channelID, &name, &createdAt, &updatedAt)
		if err != nil {
			return nil, fmt.Errorf("failed to scan channel: %w", err)
		}

		ch.ID = domain.ChannelID(channelID)
		ch.Name = name
		ch.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
		ch.UpdatedAt, _ = time.Parse("2006-01-02 15:04:05", updatedAt)

		channels = append(channels, &ch)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate channels: %w", err)
	}

	return channels, nil
}

// DeleteChannel deletes a channel from the database
func (r *ChannelRepository) DeleteChannel(ctx context.Context, id domain.ChannelID) error {
	result, err := r.db.conn.ExecContext(ctx, `
		DELETE FROM channels
		WHERE id = ?
	`, string(id))

	if err != nil {
		return fmt.Errorf("failed to delete channel: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return domain.ErrChannelNotFound
	}

	return nil
}
