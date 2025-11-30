package domain

import (
	"strings"
	"testing"
)

func TestChannel_Validate(t *testing.T) {
	tests := []struct {
		name    string
		channel Channel
		wantErr error
	}{
		{
			name:    "valid channel",
			channel: Channel{Name: "general"},
			wantErr: nil,
		},
		{
			name:    "empty name",
			channel: Channel{Name: ""},
			wantErr: ErrChannelNameRequired,
		},
		{
			name:    "name at max length",
			channel: Channel{Name: strings.Repeat("a", 100)},
			wantErr: nil,
		},
		{
			name:    "name exceeds max length",
			channel: Channel{Name: strings.Repeat("a", 101)},
			wantErr: ErrChannelNameTooLong,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.channel.Validate()
			if err != tt.wantErr {
				t.Errorf("Channel.Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestMessage_Validate(t *testing.T) {
	tests := []struct {
		name    string
		message Message
		wantErr error
	}{
		{
			name:    "valid message",
			message: Message{Text: "hello world"},
			wantErr: nil,
		},
		{
			name:    "empty text",
			message: Message{Text: ""},
			wantErr: ErrMessageEmpty,
		},
		{
			name:    "text at max length",
			message: Message{Text: strings.Repeat("a", 4000)},
			wantErr: nil,
		},
		{
			name:    "text exceeds max length",
			message: Message{Text: strings.Repeat("a", 4001)},
			wantErr: ErrMessageTooLong,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.message.Validate()
			if err != tt.wantErr {
				t.Errorf("Message.Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
