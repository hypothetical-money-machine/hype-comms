package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// Common SQLite timestamp formats to try when parsing
var sqliteTimeFormats = []string{
	"2006-01-02 15:04:05.999999999-07:00",
	"2006-01-02 15:04:05.999999-07:00",
	"2006-01-02 15:04:05-07:00",
	"2006-01-02T15:04:05.999999999Z07:00",
	"2006-01-02T15:04:05Z07:00",
	"2006-01-02 15:04:05.999999999",
	"2006-01-02 15:04:05.999999",
	"2006-01-02 15:04:05",
	time.RFC3339Nano,
	time.RFC3339,
}

// ParseSQLiteTime attempts to parse a SQLite timestamp string using multiple formats
func ParseSQLiteTime(s string) (time.Time, error) {
	for _, format := range sqliteTimeFormats {
		if t, err := time.Parse(format, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("unable to parse time: %q", s)
}

// Database wraps a SQLite connection
type Database struct {
	conn *sql.DB
}

// New creates a new SQLite database connection
func New(dsn string) (*Database, error) {
	conn, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Configure connection pool
	// SQLite works best with a single writer, but can handle multiple readers
	conn.SetMaxOpenConns(25)
	conn.SetMaxIdleConns(5)
	conn.SetConnMaxLifetime(5 * time.Minute)
	conn.SetConnMaxIdleTime(1 * time.Minute)

	// Test the connection
	if err := conn.PingContext(context.Background()); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	db := &Database{conn: conn}

	// Run migrations
	if err := db.runMigrations(context.Background()); err != nil {
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	return db, nil
}

// Close closes the database connection
func (db *Database) Close() error {
	return db.conn.Close()
}

// GetConn returns the underlying SQL database connection
func (db *Database) GetConn() *sql.DB {
	return db.conn
}

// runMigrations executes all pending migrations
func (db *Database) runMigrations(ctx context.Context) error {
	// Create schema_versions table if it doesn't exist
	if _, err := db.conn.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_versions (
			version INTEGER PRIMARY KEY,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("failed to create schema_versions table: %w", err)
	}

	// Run each migration if not already applied
	for _, m := range migrations {
		// Check if migration already applied
		var count int
		err := db.conn.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM schema_versions WHERE version = ?
		`, m.version).Scan(&count)
		if err != nil {
			return fmt.Errorf("failed to check migration %d: %w", m.version, err)
		}

		if count > 0 {
			continue // Already applied
		}

		// Execute migration
		if _, err := db.conn.ExecContext(ctx, m.sql); err != nil {
			return fmt.Errorf("failed to execute migration %d: %w", m.version, err)
		}

		// Record migration
		if _, err := db.conn.ExecContext(ctx, `
			INSERT INTO schema_versions (version) VALUES (?)
		`, m.version); err != nil {
			return fmt.Errorf("failed to record migration %d: %w", m.version, err)
		}
	}

	return nil
}
