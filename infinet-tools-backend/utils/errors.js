/**
 * Enhanced error response utilities
 * Provides consistent, user-friendly error messages
 */

/**
 * Creates a standardized error response
 * @param {number} statusCode - HTTP status code
 * @param {string} message - User-friendly error message
 * @param {string} details - Technical details (optional, for logging)
 * @param {object} additional - Additional error data
 * @returns {object} Error response object
 */
function createErrorResponse(statusCode, message, details = null, additional = {}) {
  const response = {
    error: message,
    status: statusCode,
    timestamp: new Date().toISOString(),
    ...additional
  };

  // Log technical details for debugging (not sent to client)
  if (details) {
    console.error(`[${statusCode}] ${message}`, details);
  }

  return response;
}

/**
 * Creates a 400 Bad Request error response
 * @param {string} message - Error message
 * @param {string} field - Field name that caused the error (optional)
 * @returns {object} Error response
 */
function badRequest(message, field = null) {
  const response = createErrorResponse(400, message);
  if (field) {
    response.field = field;
  }
  return response;
}

/**
 * Creates a 404 Not Found error response
 * @param {string} resource - Resource that was not found
 * @returns {object} Error response
 */
function notFound(resource = 'Resource') {
  return createErrorResponse(404, `${resource} not found`);
}

/**
 * Creates a 409 Conflict error response
 * @param {string} message - Conflict message
 * @returns {object} Error response
 */
function conflict(message) {
  return createErrorResponse(409, message);
}

/**
 * Creates a 500 Internal Server Error response
 * @param {string} message - User-friendly error message
 * @param {Error|string} error - Technical error details
 * @returns {object} Error response
 */
function internalError(message, error = null) {
  const details = error instanceof Error ? error.message : error;
  return createErrorResponse(500, message, details);
}

/**
 * Creates a 503 Service Unavailable error response
 * @param {string} service - Service name that's unavailable
 * @param {string} reason - Reason for unavailability
 * @returns {object} Error response
 */
function serviceUnavailable(service, reason = 'Service temporarily unavailable') {
  return createErrorResponse(503, `${service} is currently unavailable. ${reason}`, null, {
    service,
    retryAfter: 60 // Suggest retry after 60 seconds
  });
}

/**
 * Creates a timeout error response
 * @param {string} operation - Operation that timed out
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {object} Error response
 */
function timeoutError(operation, timeoutMs) {
  return createErrorResponse(504, 
    `${operation} timed out after ${timeoutMs}ms. Please try again with a simpler request or check your connection.`,
    null,
    { operation, timeoutMs }
  );
}

/**
 * Creates a validation error response with multiple field errors
 * @param {Array<{field: string, message: string}>} errors - Array of field errors
 * @returns {object} Error response
 */
function validationError(errors) {
  return createErrorResponse(400, 'Validation failed. Please check your input.', null, {
    errors: Array.isArray(errors) ? errors : [errors]
  });
}

/**
 * Wraps async route handlers with better error handling
 * @param {Function} handler - Async route handler
 * @returns {Function} Wrapped handler
 */
function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      console.error('Unhandled error in route handler:', error);
      
      // If response already sent, pass to Express error handler
      if (res.headersSent) {
        return next(error);
      }

      // Determine error type and create appropriate response
      let statusCode = 500;
      let message = 'An unexpected error occurred. Please try again later.';

      if (error.name === 'ValidationError') {
        statusCode = 400;
        message = error.message || 'Invalid input provided';
      } else if (error.name === 'TimeoutError') {
        statusCode = 504;
        message = error.message || 'Request timed out';
      } else if (error.response) {
        // Axios error
        statusCode = error.response.status || 500;
        message = error.response.data?.error || error.message || message;
      } else if (error.status) {
        // Error with status property
        statusCode = error.status;
        message = error.message || message;
      }

      res.status(statusCode).json(createErrorResponse(statusCode, message, error));
    }
  };
}

module.exports = {
  createErrorResponse,
  badRequest,
  notFound,
  conflict,
  internalError,
  serviceUnavailable,
  timeoutError,
  validationError,
  asyncHandler
};

