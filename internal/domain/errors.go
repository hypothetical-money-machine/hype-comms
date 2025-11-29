package domain

import "errors"

var (
	ErrChannelNotFound      = errors.New("channel not found")
	ErrChannelAlreadyExists = errors.New("channel already exists")
	ErrChannelNameRequired  = errors.New("channel name is required")
	ErrChannelNameTooLong   = errors.New("channel name exceeds 100 characters")
	ErrMessageEmpty         = errors.New("message text is empty")
	ErrMessageTooLong       = errors.New("message exceeds 4000 characters")
	ErrMessageNotFound      = errors.New("message not found")
)
