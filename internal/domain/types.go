package domain

import "time"

// ChannelID is a unique identifier for a channel
type ChannelID string

// MessageID is a unique identifier for a message
type MessageID string

// Channel represents a communication channel
type Channel struct {
	ID        ChannelID
	Name      string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Validate checks if the channel is valid
func (c *Channel) Validate() error {
	if c.Name == "" {
		return ErrChannelNameRequired
	}
	if len(c.Name) > 100 {
		return ErrChannelNameTooLong
	}
	return nil
}

// Message represents a message in a channel
type Message struct {
	ID        MessageID
	ChannelID ChannelID
	Text      string
	CreatedAt time.Time
}

// Validate checks if the message is valid
func (m *Message) Validate() error {
	if m.Text == "" {
		return ErrMessageEmpty
	}
	if len(m.Text) > 4000 {
		return ErrMessageTooLong
	}
	return nil
}
