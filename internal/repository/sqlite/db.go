package sqlite

import (
	"context"
	"database/sql"
	"fmt"

	_ "github.com/mattn/go-sqlite3"
)

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

	// Execute the init schema migration
	if _, err := db.conn.ExecContext(ctx, initSchemaSQL); err != nil {
		return fmt.Errorf("failed to execute init schema: %w", err)
	}

	// Record that version 1 was applied
	if _, err := db.conn.ExecContext(ctx, `
		INSERT OR IGNORE INTO schema_versions (version) VALUES (1)
	`); err != nil {
		return fmt.Errorf("failed to record migration: %w", err)
	}

	return nil
}
