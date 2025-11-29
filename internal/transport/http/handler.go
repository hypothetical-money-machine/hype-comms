package http

import (
	"encoding/json"
	"net/http"

	"github.com/hype-comms/hmm-chat/internal/domain"
	"github.com/hype-comms/hmm-chat/internal/usecase"
)

// Handler handles HTTP requests
type Handler struct {
	channelUC *usecase.ChannelUseCase
	messageUC *usecase.MessageUseCase
}

// NewHandler creates a new HTTP handler
func NewHandler(chUC *usecase.ChannelUseCase, msgUC *usecase.MessageUseCase) *Handler {
	return &Handler{
		channelUC: chUC,
		messageUC: msgUC,
	}
}

// CreateChannel handles POST /api/channels
func (h *Handler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	var req CreateChannelRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErrorResponse(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	ch, err := h.channelUC.CreateChannel(r.Context(), req.Name)
	if err != nil {
		handleDomainError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(DomainChannelToResponse(ch))
}

// ListChannels handles GET /api/channels
func (h *Handler) ListChannels(w http.ResponseWriter, r *http.Request) {
	channels, err := h.channelUC.ListChannels(r.Context())
	if err != nil {
		writeErrorResponse(w, http.StatusInternalServerError, "Failed to list channels")
		return
	}

	responses := make([]ChannelResponse, len(channels))
	for i, ch := range channels {
		responses[i] = DomainChannelToResponse(ch)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(responses)
}

// GetChannel handles GET /api/channels/:id
func (h *Handler) GetChannel(w http.ResponseWriter, r *http.Request, id string) {
	ch, err := h.channelUC.GetChannel(r.Context(), domain.ChannelID(id))
	if err != nil {
		handleDomainError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(DomainChannelToResponse(ch))
}

// handleDomainError converts domain errors to HTTP responses
func handleDomainError(w http.ResponseWriter, err error) {
	switch err {
	case domain.ErrChannelNotFound, domain.ErrMessageNotFound:
		writeErrorResponse(w, http.StatusNotFound, err.Error())
	case domain.ErrChannelNameRequired, domain.ErrChannelNameTooLong, domain.ErrMessageEmpty, domain.ErrMessageTooLong:
		writeErrorResponse(w, http.StatusBadRequest, err.Error())
	case domain.ErrChannelAlreadyExists:
		writeErrorResponse(w, http.StatusConflict, err.Error())
	default:
		writeErrorResponse(w, http.StatusInternalServerError, "Internal server error")
	}
}

// writeErrorResponse writes an error response to the client
func writeErrorResponse(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(ErrorResponse{Error: message})
}
