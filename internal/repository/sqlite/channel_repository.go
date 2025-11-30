package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/hype-comms/hmm-chat/internal/domain"
	"github.com/mattn/go-sqlite3"
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
	slog.Debug("Creating channel", "name", ch.Name, "id", ch.ID)
	now := time.Now()
	_, err := r.db.conn.ExecContext(ctx, `
		INSERT INTO channels (id, name, created_at, updated_at)
		VALUES (?, ?, ?, ?)
	`, string(ch.ID), ch.Name, now, now)

	if err != nil {
		// Check if it's a unique constraint violation (duplicate name)
		var sqliteErr sqlite3.Error
		if errors.As(err, &sqliteErr) && sqliteErr.ExtendedCode == sqlite3.ErrConstraintUnique {
			slog.Debug("CreateChannel failed: channel already exists", "name", ch.Name)
			return domain.ErrChannelAlreadyExists
		}
		slog.Error("CreateChannel error", "error", err)
		return fmt.Errorf("failed to create channel: %w", err)
	}

	ch.CreatedAt = now
	ch.UpdatedAt = now
	slog.Debug("Channel created", "name", ch.Name)
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
	if t, err := ParseSQLiteTime(createdAt); err != nil {
		slog.Warn("Failed to parse channel created_at", "channel_id", channelID, "value", createdAt, "error", err)
	} else {
		ch.CreatedAt = t
	}
	if t, err := ParseSQLiteTime(updatedAt); err != nil {
		slog.Warn("Failed to parse channel updated_at", "channel_id", channelID, "value", updatedAt, "error", err)
	} else {
		ch.UpdatedAt = t
	}

	return &ch, nil
}

// maxChannelsLimit is the maximum number of channels to return in a single query
const maxChannelsLimit = 1000

// ListChannels returns all channels from the database (limited to prevent unbounded results)
func (r *ChannelRepository) ListChannels(ctx context.Context) ([]*domain.Channel, error) {
	slog.Debug("Listing channels")
	rows, err := r.db.conn.QueryContext(ctx, `
		SELECT id, name, created_at, updated_at
		FROM channels
		ORDER BY created_at DESC
		LIMIT ?
	`, maxChannelsLimit)
	if err != nil {
		slog.Error("ListChannels error", "error", err)
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
			slog.Error("ListChannels scan error", "error", err)
			return nil, fmt.Errorf("failed to scan channel: %w", err)
		}

		ch.ID = domain.ChannelID(channelID)
		ch.Name = name
		if t, err := ParseSQLiteTime(createdAt); err != nil {
			slog.Warn("Failed to parse channel created_at", "channel_id", channelID, "value", createdAt, "error", err)
		} else {
			ch.CreatedAt = t
		}
		if t, err := ParseSQLiteTime(updatedAt); err != nil {
			slog.Warn("Failed to parse channel updated_at", "channel_id", channelID, "value", updatedAt, "error", err)
		} else {
			ch.UpdatedAt = t
		}

		channels = append(channels, &ch)
	}

	if err := rows.Err(); err != nil {
		slog.Error("ListChannels iteration error", "error", err)
		return nil, fmt.Errorf("failed to iterate channels: %w", err)
	}

	slog.Debug("ListChannels complete", "count", len(channels))
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
